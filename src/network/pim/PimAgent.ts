import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type PimConfig, type PimInterfaceRuntime, type PimNeighborEntry,
  type PimMode, type PimPacket, type PimHelloOption,
  type PimMroutEntry, type PimRpEntry, type PimJoinPruneBody,
  type PimMessageType, type PimBsrCandidate,
  type PimBootstrapBody, type PimCandidateRpBody,
  createDefaultPimConfig, defaultInterfaceRuntime, makeNeighborKey, makeMroutKey,
  compareDrCandidate, compareBsrCandidate, getOption, matchesGroupRange, ipToUint32,
  IP_PROTO_PIM, PIM_ALL_ROUTERS, PIM_ALL_ROUTERS_MAC,
} from './types';
import {
  MACAddress,
  IPAddress,
  type EthernetFrame,
  type IPv4Packet,
} from '../core/types';
import { buildIpv4Frame } from '../layers/internet/InternetLayer';
import { Logger } from '../core/Logger';

export interface PimHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
}

export class PimAgent {
  private config: PimConfig = createDefaultPimConfig();
  private helloTimer: TimerHandle | null = null;
  private expiryTimer: TimerHandle | null = null;
  private refreshTimer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly host: PimHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.installSubscribers();
    if (this.config.enabled) this.startTimers();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    this.stopTimers();
  }

  getConfig(): Readonly<PimConfig> { return this.config; }

  /**
   * Protocol clock. Every timestamp this agent records and compares comes
   * from the scheduler, so virtual time really does age neighbours, join
   * state and BSR/RP entries.
   */
  nowMs(): number { return this.getScheduler().now(); }

  enableInterface(iface: string, mode: PimMode = 'sparse'): void {
    const rt = this.ensureIface(iface);
    rt.enabled = true;
    rt.mode = mode;
    this.transmitHello(rt);
    this.recomputeDr(rt);
  }

  disableInterface(iface: string): void {
    const rt = this.config.interfaces.get(iface);
    if (!rt) return;
    rt.enabled = false;
    for (const [k, n] of this.config.neighbors) {
      if (n.iface === iface) {
        this.config.neighbors.delete(k);
        this.emitNeighborLost(n, 'config');
      }
    }
    rt.designatedRouterIp = null;
  }

  setDrPriority(iface: string, priority: number): void {
    const rt = this.ensureIface(iface);
    rt.drPriority = priority;
    if (rt.enabled) {
      this.transmitHello(rt);
      this.recomputeDr(rt);
    }
  }

  setHelloInterval(iface: string, seconds: number): void {
    const rt = this.ensureIface(iface);
    rt.helloIntervalSec = seconds;
    rt.helloHoldSec = Math.max(seconds * 3 + seconds / 2, 105);
  }

  getInterfaceRuntime(iface: string): PimInterfaceRuntime | undefined {
    return this.config.interfaces.get(iface);
  }

  listNeighbors(iface?: string): PimNeighborEntry[] {
    const all = Array.from(this.config.neighbors.values());
    const filtered = iface ? all.filter(n => n.iface === iface) : all;
    return filtered.sort((a, b) =>
      a.iface === b.iface ? a.neighborIp.localeCompare(b.neighborIp) : a.iface.localeCompare(b.iface));
  }

  addStaticRp(rpAddress: string, groupRangeAddress = '224.0.0.0', groupRangeMaskBits = 4): void {
    const existing = this.config.rps.find((r) =>
      r.rpAddress === rpAddress &&
      r.groupRangeAddress === groupRangeAddress &&
      r.groupRangeMaskBits === groupRangeMaskBits);
    if (existing) return;
    this.config.rps.push({
      rpAddress, groupRangeAddress, groupRangeMaskBits, isStatic: true,
    });
    for (const m of this.config.mroutes.values()) {
      if (m.entryType !== 'star-g') continue;
      if (!matchesGroupRange(m.groupAddress, groupRangeAddress, groupRangeMaskBits)) continue;
      m.rpAddress = rpAddress;
      this.maybeRefreshUpstream(m);
    }
  }

  removeStaticRp(rpAddress: string): void {
    const before = this.config.rps.length;
    this.config.rps = this.config.rps.filter((r) => r.rpAddress !== rpAddress);
    if (this.config.rps.length === before) return;
    for (const m of this.config.mroutes.values()) {
      if (m.rpAddress === rpAddress) {
        m.rpAddress = this.resolveRpForGroup(m.groupAddress);
        this.getBus().publish({
          topic: 'pim.rp.changed',
          payload: {
            deviceId: this.host.id, hostname: this.host.getHostname(),
            group: m.groupAddress, rpAddress: m.rpAddress,
          },
        });
      }
    }
  }

  /**
   * Longest-match RP lookup across both sources. A more specific group
   * range always wins whatever its origin; on an equal mask the static
   * entry wins, matching real Cisco/VRP behaviour.
   */
  resolveRpForGroup(group: string): string | null {
    return this.resolveRpEntryForGroup(group)?.rpAddress ?? null;
  }

  resolveRpEntryForGroup(group: string): PimRpEntry | null {
    let best: PimRpEntry | null = null;
    for (const r of [...this.config.rps, ...this.config.learnedRps]) {
      if (!matchesGroupRange(group, r.groupRangeAddress, r.groupRangeMaskBits)) continue;
      if (!best) { best = r; continue; }
      if (r.groupRangeMaskBits > best.groupRangeMaskBits) { best = r; continue; }
      if (r.groupRangeMaskBits === best.groupRangeMaskBits && r.isStatic && !best.isStatic) {
        best = r;
      }
    }
    return best;
  }

  /** Every RP this router knows about, static first, for display. */
  listRps(): PimRpEntry[] {
    return [...this.config.rps, ...this.config.learnedRps];
  }

  // ─── Bootstrap Router (RFC 5059) ─────────────────────────────────

  /** `ip pim bsr-candidate <iface> [hash-len] [priority]` / VRP `c-bsr`. */
  setBsrCandidate(address: string, priority: number): void {
    this.config.bsrCandidate = { address, priority };
    this.electBsr();
  }

  clearBsrCandidate(): void {
    const wasSelf = this.isSelfBsr();
    this.config.bsrCandidate = null;
    // Standing down as BSR also drops the RP set we were originating; a
    // remaining BSR on the segment will re-teach it.
    if (wasSelf) {
      this.config.currentBsr = null;
      this.config.lastBsrHeardMs = null;
      this.config.learnedRps = [];
      this.config.candidateRps.clear();
      this.rebindMroutesToRp();
    }
  }

  /** `ip pim rp-candidate <iface> [group-list] [priority]` / VRP `c-rp`. */
  setRpCandidate(
    address: string, priority = 0,
    groupRangeAddress = '224.0.0.0', groupRangeMaskBits = 4,
  ): void {
    this.config.rpCandidate = { address, priority, groupRangeAddress, groupRangeMaskBits };
    this.config.lastCandidateRpSentMs = null;
    this.advertiseCandidateRp();
  }

  clearRpCandidate(): void {
    this.config.rpCandidate = null;
  }

  private isSelfBsr(): boolean {
    const c = this.config.bsrCandidate;
    return c !== null && this.config.currentBsr?.address === c.address;
  }

  /**
   * RFC 5059 §3.1: the highest-priority candidate wins, ties broken by the
   * highest address. A router with no C-BSR configuration simply accepts
   * whatever BSR it hears.
   */
  private electBsr(challenger?: PimBsrCandidate): void {
    const previous = this.config.currentBsr;
    let winner = this.config.currentBsr;
    for (const c of [this.config.bsrCandidate, challenger]) {
      if (!c) continue;
      if (!winner || compareBsrCandidate(c, winner) < 0) winner = c;
    }
    if (!winner) return;
    if (challenger && winner.address === challenger.address) {
      this.config.lastBsrHeardMs = this.nowMs();
    }
    if (previous && previous.address === winner.address && previous.priority === winner.priority) {
      return;
    }
    this.config.currentBsr = winner;
    if (this.isSelfBsr()) this.config.lastBsrHeardMs = null;
    this.getBus().publish({
      topic: 'pim.bsr.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        oldBsrIp: previous?.address ?? null,
        newBsrIp: winner.address,
        priority: winner.priority,
        isSelf: this.isSelfBsr(),
      },
    });
    Logger.info(this.host.id, 'pim:bsr',
      `${this.host.name}: BSR ${previous?.address ?? '(none)'} → ${winner.address}`);
    // A freshly elected BSR announces itself without waiting for the timer.
    if (this.isSelfBsr()) this.originateBootstrap();
  }

  private onBootstrap(inPort: string, senderIp: string, body: PimBootstrapBody): void {
    const advertised: PimBsrCandidate = { address: body.bsrAddress, priority: body.bsrPriority };
    const mine = this.config.bsrCandidate;
    // A candidate that outranks the sender keeps its own view and does not
    // relay — the losing BSR will hear ours and stand down.
    if (mine && compareBsrCandidate(mine, advertised) < 0) {
      this.electBsr();
      return;
    }
    this.electBsr(advertised);
    if (this.config.currentBsr?.address !== advertised.address) return;
    this.applyBootstrapRps(body);
    this.relayBootstrap(inPort, body);
    if (this.config.rpCandidate) this.advertiseCandidateRp();
  }

  private applyBootstrapRps(body: PimBootstrapBody): void {
    const now = this.nowMs();
    const fresh: PimRpEntry[] = [];
    for (const g of body.groups) {
      for (const rp of g.rps) {
        fresh.push({
          rpAddress: rp.rpAddress,
          groupRangeAddress: g.groupRangeAddress,
          groupRangeMaskBits: g.groupRangeMaskBits,
          isStatic: false,
          priority: rp.priority,
          expiresMs: now + rp.holdtimeSec * 1000,
        });
      }
    }
    this.config.learnedRps = fresh;
    this.config.bootstrapFragmentTag = body.fragmentTag;
    this.rebindMroutesToRp();
    this.getBus().publish({
      topic: 'pim.rp.learned',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        bsrIp: body.bsrAddress,
        rps: fresh.map(r => ({
          rpAddress: r.rpAddress,
          groupRange: `${r.groupRangeAddress}/${r.groupRangeMaskBits}`,
          priority: r.priority ?? 0,
        })),
      },
    });
  }

  /** Re-point every (*,G) whose RP choice may have changed. */
  private rebindMroutesToRp(): void {
    for (const m of this.config.mroutes.values()) {
      const rp = this.resolveRpForGroup(m.groupAddress);
      if (rp === m.rpAddress) continue;
      m.rpAddress = rp;
      this.getBus().publish({
        topic: 'pim.rp.changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          group: m.groupAddress, rpAddress: rp,
        },
      });
      this.maybeRefreshUpstream(m);
    }
  }

  private onCandidateRp(body: PimCandidateRpBody): void {
    // Only the elected BSR collects Candidate-RP-Advertisements.
    if (!this.isSelfBsr()) return;
    const now = this.nowMs();
    for (const g of body.groups) {
      const key = `${body.rpAddress}|${g.groupRangeAddress}/${g.groupRangeMaskBits}`;
      this.config.candidateRps.set(key, {
        rp: {
          rpAddress: body.rpAddress,
          groupRangeAddress: g.groupRangeAddress,
          groupRangeMaskBits: g.groupRangeMaskBits,
          isStatic: false,
          priority: body.priority,
        },
        expiresMs: now + body.holdtimeSec * 1000,
      });
    }
    this.originateBootstrap();
  }

  /** Build and flood this router's own Bootstrap message. */
  private originateBootstrap(): void {
    const self = this.config.bsrCandidate;
    if (!self || !this.isSelfBsr()) return;
    const byRange = new Map<string, PimBootstrapBody['groups'][number]>();
    for (const { rp, expiresMs } of this.config.candidateRps.values()) {
      const rangeKey = `${rp.groupRangeAddress}/${rp.groupRangeMaskBits}`;
      let g = byRange.get(rangeKey);
      if (!g) {
        g = {
          groupRangeAddress: rp.groupRangeAddress,
          groupRangeMaskBits: rp.groupRangeMaskBits,
          rps: [],
        };
        byRange.set(rangeKey, g);
      }
      g.rps.push({
        rpAddress: rp.rpAddress,
        priority: rp.priority ?? 0,
        holdtimeSec: Math.max(1, Math.ceil((expiresMs - this.nowMs()) / 1000)),
      });
    }
    this.config.bootstrapFragmentTag++;
    const body: PimBootstrapBody = {
      bsrAddress: self.address,
      bsrPriority: self.priority,
      fragmentTag: this.config.bootstrapFragmentTag,
      groups: Array.from(byRange.values()),
    };
    // The BSR is a receiver of its own set too, so its RP table matches
    // what every other router in the domain will learn.
    this.applyBootstrapRps(body);
    this.config.lastBootstrapSentMs = this.nowMs();
    for (const rt of this.config.interfaces.values()) {
      if (rt.enabled) this.transmitBootstrap(rt.iface, body);
    }
  }

  /** Forward an accepted Bootstrap out of every interface but the one it came in on. */
  private relayBootstrap(inPort: string, body: PimBootstrapBody): void {
    for (const rt of this.config.interfaces.values()) {
      if (!rt.enabled || rt.iface === inPort) continue;
      this.transmitBootstrap(rt.iface, body);
    }
  }

  private advertiseCandidateRp(): void {
    const c = this.config.rpCandidate;
    if (!c) return;
    const bsr = this.config.currentBsr;
    if (!bsr) return;
    const body: PimCandidateRpBody = {
      rpAddress: c.address,
      priority: c.priority,
      holdtimeSec: Math.ceil(this.config.candidateRpIntervalSec * 2.5),
      groups: [{
        groupRangeAddress: c.groupRangeAddress,
        groupRangeMaskBits: c.groupRangeMaskBits,
      }],
    };
    this.config.lastCandidateRpSentMs = this.nowMs();
    // We are the BSR ourselves: no need to put it on the wire.
    if (this.isSelfBsr()) { this.onCandidateRp(body); return; }
    for (const rt of this.config.interfaces.values()) {
      if (rt.enabled) this.transmitCandidateRp(rt.iface, body);
    }
  }

  listMroutes(): PimMroutEntry[] {
    return Array.from(this.config.mroutes.values()).sort((a, b) =>
      a.groupAddress === b.groupAddress
        ? (a.sourceAddress ?? '*').localeCompare(b.sourceAddress ?? '*')
        : a.groupAddress.localeCompare(b.groupAddress));
  }

  getMroute(group: string, source: string | null = null): PimMroutEntry | undefined {
    return this.config.mroutes.get(makeMroutKey(group, source));
  }

  joinGroup(group: string, outgoingInterface: string): void {
    const m = this.ensureStarG(group);
    if (m.outgoingInterfaces.has(outgoingInterface)) return;
    m.outgoingInterfaces.add(outgoingInterface);
    this.emitMrout(m, 'oif-added');
    this.maybeRefreshUpstream(m);
  }

  leaveGroup(group: string, outgoingInterface: string): void {
    const m = this.config.mroutes.get(makeMroutKey(group, null));
    if (!m) return;
    if (!m.outgoingInterfaces.delete(outgoingInterface)) return;
    this.emitMrout(m, 'oif-removed');
    if (m.outgoingInterfaces.size === 0) {
      this.sendPrune(m);
      this.config.mroutes.delete(makeMroutKey(group, null));
      this.emitMrout(m, 'prune');
    } else {
      this.maybeRefreshUpstream(m);
    }
  }

  setJoinPruneInterval(seconds: number): void {
    this.config.joinPruneIntervalSec = Math.max(5, seconds);
    this.config.joinPruneHoldtimeSec = Math.max(15, Math.floor(seconds * 3.5));
  }

  handleIp(inPort: string, srcIp: IPAddress, ipPkt: IPv4Packet): void {
    // A stopped agent has no timers and must not answer on the wire
    // either, or a shut-down router keeps driving its peers' state.
    if (!this.running) return;
    if (!this.config.enabled) return;
    if (ipPkt.protocol !== IP_PROTO_PIM) return;
    const payload = ipPkt.payload as PimPacket | undefined;
    if (!payload || payload.type !== 'pim') return;
    const rt = this.config.interfaces.get(inPort);
    if (!rt || !rt.enabled) return;
    const senderIp = srcIp.toString();

    this.getBus().publish({
      topic: 'pim.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: inPort, messageType: payload.messageType, fromIp: senderIp,
      },
    });

    if (payload.messageType === 'join-prune') {
      if (payload.joinPrune) this.onJoinPrune(rt, senderIp, payload.joinPrune);
      return;
    }

    if (payload.messageType === 'bootstrap') {
      if (payload.bootstrap) this.onBootstrap(inPort, senderIp, payload.bootstrap);
      return;
    }

    if (payload.messageType === 'candidate-rp-advertisement') {
      if (payload.candidateRp) this.onCandidateRp(payload.candidateRp);
      return;
    }

    if (payload.messageType !== 'hello') return;

    const holdtime = (getOption<number>(payload.options, 'holdtime') ?? rt.helloHoldSec);
    const drPriOpt = payload.options.find(o => o.type === 'dr-priority');
    const drPriority = (drPriOpt?.value as number | undefined) ?? 1;
    const generationId = (getOption<number>(payload.options, 'generation-id') ?? 0);
    const addressList = (getOption<string[]>(payload.options, 'address-list') ?? []);

    const k = makeNeighborKey(inPort, senderIp);
    const existing = this.config.neighbors.get(k);
    if (existing && existing.generationId !== generationId && existing.generationId !== 0) {
      this.config.neighbors.delete(k);
      this.emitNeighborLost(existing, 'gen-id-changed');
    }
    const had = this.config.neighbors.has(k);
    const entry: PimNeighborEntry = {
      iface: inPort, neighborIp: senderIp,
      helloHoldSec: holdtime,
      drPriority,
      generationId,
      hasDrPriorityOption: !!drPriOpt,
      lastHeardMs: this.nowMs(),
      upSinceMs: existing?.upSinceMs ?? this.nowMs(),
      addressList,
    };
    this.config.neighbors.set(k, entry);
    if (!had) {
      this.getBus().publish({
        topic: 'pim.neighbor.added',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          iface: inPort, neighborIp: senderIp,
          drPriority, generationId,
        },
      });
      Logger.info(this.host.id, 'pim:neighbor',
        `${this.host.name}: ${inPort} new PIM neighbor ${senderIp}`);
      this.transmitHello(rt);
    }
    this.recomputeDr(rt);
  }

  private ensureStarG(group: string): PimMroutEntry {
    const k = makeMroutKey(group, null);
    let m = this.config.mroutes.get(k);
    if (!m) {
      const rp = this.resolveRpForGroup(group);
      m = {
        groupAddress: group, sourceAddress: null, entryType: 'star-g',
        incomingInterface: null, upstreamNeighborIp: null, rpAddress: rp,
        outgoingInterfaces: new Set(),
        joinExpiryMs: 0, uptimeMs: this.nowMs(), lastJoinSentMs: 0,
      };
      this.config.mroutes.set(k, m);
    }
    return m;
  }

  private maybeRefreshUpstream(m: PimMroutEntry): void {
    if (m.outgoingInterfaces.size === 0) return;
    const rp = m.rpAddress ?? this.resolveRpForGroup(m.groupAddress);
    if (!rp) return;
    m.rpAddress = rp;
    const upstream = this.findUpstreamForRp(rp);
    if (!upstream) return;
    m.incomingInterface = upstream.iface;
    m.upstreamNeighborIp = upstream.neighborIp;
    this.sendJoin(m);
  }

  private findUpstreamForRp(rpIp: string): { iface: string; neighborIp: string } | null {
    const rpu = ipToUint32(rpIp);
    let best: { iface: string; neighborIp: string; pfxlen: number } | null = null;
    for (const port of this.host.getPorts()) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask) continue;
      const ifaceName = port.getName();
      const rt = this.config.interfaces.get(ifaceName);
      if (!rt || !rt.enabled) continue;
      const local = ipToUint32(ip.toString());
      const m = ipToUint32(mask.toString());
      if ((local & m) !== (rpu & m)) continue;
      const pfxlen = (() => { let n = 0; const v = m >>> 0; for (let i = 0; i < 32; i++) if (((v >>> (31 - i)) & 1) === 1) n++; return n; })();
      const neigh = this.listNeighbors(ifaceName)[0];
      if (!neigh) continue;
      if (!best || pfxlen > best.pfxlen) {
        best = { iface: ifaceName, neighborIp: neigh.neighborIp, pfxlen };
      }
    }
    if (best) return { iface: best.iface, neighborIp: best.neighborIp };
    for (const n of this.config.neighbors.values()) {
      const rt = this.config.interfaces.get(n.iface);
      if (!rt || !rt.enabled) continue;
      return { iface: n.iface, neighborIp: n.neighborIp };
    }
    return null;
  }

  private sendJoin(m: PimMroutEntry): void {
    if (!m.incomingInterface || !m.upstreamNeighborIp) return;
    const body: PimJoinPruneBody = {
      upstreamNeighborIp: m.upstreamNeighborIp,
      holdtimeSec: this.config.joinPruneHoldtimeSec,
      groups: [{
        groupAddress: m.groupAddress,
        joinedSources: [],
        prunedSources: [],
        joinStarG: true,
        pruneStarG: false,
      }],
    };
    this.transmitJoinPrune(m.incomingInterface, body);
    m.lastJoinSentMs = this.nowMs();
    m.joinExpiryMs = this.nowMs() + this.config.joinPruneHoldtimeSec * 1000;
    this.emitMrout(m, 'join');
  }

  private sendPrune(m: PimMroutEntry): void {
    if (!m.incomingInterface || !m.upstreamNeighborIp) return;
    const body: PimJoinPruneBody = {
      upstreamNeighborIp: m.upstreamNeighborIp,
      holdtimeSec: this.config.joinPruneHoldtimeSec,
      groups: [{
        groupAddress: m.groupAddress,
        joinedSources: [],
        prunedSources: [],
        joinStarG: false,
        pruneStarG: true,
      }],
    };
    this.transmitJoinPrune(m.incomingInterface, body);
  }

  private transmitJoinPrune(iface: string, body: PimJoinPruneBody): void {
    this.transmit(iface, 'join-prune', 32 + body.groups.length * 16, (p) => { p.joinPrune = body; });
  }

  private transmitBootstrap(iface: string, body: PimBootstrapBody): void {
    this.transmit(iface, 'bootstrap', 24 + body.groups.length * 16, (p) => { p.bootstrap = body; });
  }

  private transmitCandidateRp(iface: string, body: PimCandidateRpBody): void {
    this.transmit(iface, 'candidate-rp-advertisement', 16 + body.groups.length * 8,
      (p) => { p.candidateRp = body; });
  }

  /**
   * One egress path for every non-Hello PIM message: same all-routers
   * destination, same TTL-1 IPv4 header, so a new message type can never
   * drift from the ones already on the wire.
   */
  private transmit(
    iface: string, messageType: PimMessageType, bodyBytes: number,
    fill: (payload: PimPacket) => void,
  ): void {
    const port = this.host.getPort(iface);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const payload: PimPacket = {
      type: 'pim', version: 2, messageType,
      reserved: 0, checksum: 0, options: [],
      senderIp: srcIp.toString(),
    };
    fill(payload);
    const eth = buildIpv4Frame({
      sourceIp: srcIp, destinationIp: new IPAddress(PIM_ALL_ROUTERS),
      sourceMac: port.getMAC(), destinationMac: new MACAddress(PIM_ALL_ROUTERS_MAC),
      protocol: IP_PROTO_PIM, ttl: 1,
      payload, payloadBytes: bodyBytes,
      options: { tos: 0xc0, flags: 0 },
    });
    this.host.sendFrame(iface, eth);
    this.getBus().publish({
      topic: 'pim.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface, messageType,
        destinationIp: PIM_ALL_ROUTERS,
      },
    });
  }

  private onJoinPrune(rt: PimInterfaceRuntime, senderIp: string, body: PimJoinPruneBody): void {
    const port = this.host.getPort(rt.iface);
    const myIp = port?.getIPAddress()?.toString();
    if (!myIp || body.upstreamNeighborIp !== myIp) return;
    for (const g of body.groups) {
      const k = makeMroutKey(g.groupAddress, null);
      if (g.joinStarG) {
        let m = this.config.mroutes.get(k);
        if (!m) {
          m = {
            groupAddress: g.groupAddress, sourceAddress: null, entryType: 'star-g',
            incomingInterface: null, upstreamNeighborIp: null,
            rpAddress: this.resolveRpForGroup(g.groupAddress),
            outgoingInterfaces: new Set(),
            joinExpiryMs: 0, uptimeMs: this.nowMs(), lastJoinSentMs: 0,
          };
          this.config.mroutes.set(k, m);
        }
        const added = !m.outgoingInterfaces.has(rt.iface);
        m.outgoingInterfaces.add(rt.iface);
        m.joinExpiryMs = this.nowMs() + body.holdtimeSec * 1000;
        if (added) this.emitMrout(m, 'oif-added');
        this.maybeRefreshUpstream(m);
      } else if (g.pruneStarG) {
        const m = this.config.mroutes.get(k);
        if (!m) continue;
        if (m.outgoingInterfaces.delete(rt.iface)) {
          this.emitMrout(m, 'oif-removed');
        }
        if (m.outgoingInterfaces.size === 0) {
          this.config.mroutes.delete(k);
          this.emitMrout(m, 'prune');
        }
      }
    }
  }

  private emitMrout(m: PimMroutEntry, reason: 'join' | 'prune' | 'oif-added' | 'oif-removed' | 'expiry'): void {
    this.getBus().publish({
      topic: 'pim.mroute.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        group: m.groupAddress, source: m.sourceAddress,
        incomingInterface: m.incomingInterface,
        outgoingInterfaces: Array.from(m.outgoingInterfaces),
        reason,
      },
    });
  }

  private recomputeDr(rt: PimInterfaceRuntime): void {
    const port = this.host.getPort(rt.iface);
    const myIp = port?.getIPAddress()?.toString();
    if (!myIp) return;
    const candidates: Array<{ drPriority: number; hasDrPriority: boolean; ip: string }> = [
      { drPriority: rt.drPriority, hasDrPriority: true, ip: myIp },
    ];
    for (const n of this.config.neighbors.values()) {
      if (n.iface !== rt.iface) continue;
      candidates.push({ drPriority: n.drPriority, hasDrPriority: n.hasDrPriorityOption, ip: n.neighborIp });
    }
    let best = candidates[0];
    for (const c of candidates.slice(1)) {
      if (compareDrCandidate(c, best) < 0) best = c;
    }
    const oldDr = rt.designatedRouterIp;
    if (oldDr !== best.ip) {
      rt.designatedRouterIp = best.ip;
      this.getBus().publish({
        topic: 'pim.dr.changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          iface: rt.iface, oldDrIp: oldDr, newDrIp: best.ip,
        },
      });
      Logger.info(this.host.id, 'pim:dr',
        `${this.host.name}: ${rt.iface} DR ${oldDr ?? '(none)'} → ${best.ip}`);
    }
  }

  private emitNeighborLost(n: PimNeighborEntry, reason: 'timeout' | 'link' | 'gen-id-changed' | 'config'): void {
    this.getBus().publish({
      topic: 'pim.neighbor.lost',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: n.iface, neighborIp: n.neighborIp, reason,
      },
    });
  }

  private transmitHello(rt: PimInterfaceRuntime): void {
    if (!rt.enabled) return;
    const port = this.host.getPort(rt.iface);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const opts: PimHelloOption[] = [
      { type: 'holdtime', value: rt.helloHoldSec },
      { type: 'dr-priority', value: rt.drPriority },
      { type: 'generation-id', value: rt.generationId },
      { type: 'lan-prune-delay', value: 500 },
    ];
    const payload: PimPacket = {
      type: 'pim', version: 2, messageType: 'hello',
      reserved: 0, checksum: 0,
      options: opts,
      senderIp: srcIp.toString(),
    };
    const eth = buildIpv4Frame({
      sourceIp: srcIp, destinationIp: new IPAddress(PIM_ALL_ROUTERS),
      sourceMac: port.getMAC(), destinationMac: new MACAddress(PIM_ALL_ROUTERS_MAC),
      protocol: IP_PROTO_PIM, ttl: 1,
      payload, payloadBytes: 8 + opts.length * 8,
      options: { tos: 0xc0, flags: 0 },
    });
    this.host.sendFrame(rt.iface, eth);
    rt.lastHelloSentMs = this.nowMs();
    this.getBus().publish({
      topic: 'pim.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: rt.iface, messageType: 'hello',
        destinationIp: PIM_ALL_ROUTERS,
      },
    });
  }

  private ensureIface(iface: string): PimInterfaceRuntime {
    let rt = this.config.interfaces.get(iface);
    if (!rt) {
      rt = defaultInterfaceRuntime(iface);
      this.config.interfaces.set(iface, rt);
    }
    return rt;
  }

  private startTimers(): void {
    const s = this.getScheduler();
    this.scheduler = s;
    if (this.helloTimer === null) {
      this.helloTimer = s.setInterval(() => {
        const now = this.nowMs();
        for (const rt of this.config.interfaces.values()) {
          if (!rt.enabled) continue;
          if (now - rt.lastHelloSentMs >= rt.helloIntervalSec * 1000) {
            this.transmitHello(rt);
          }
        }
      }, 1000);
    }
    if (this.expiryTimer === null) {
      this.expiryTimer = s.setInterval(() => this.expireDue(), 1000);
    }
    if (this.refreshTimer === null) {
      this.refreshTimer = s.setInterval(() => {
        const now = this.nowMs();
        for (const m of this.config.mroutes.values()) {
          if (m.outgoingInterfaces.size === 0) continue;
          if (now - m.lastJoinSentMs >= this.config.joinPruneIntervalSec * 1000) {
            this.maybeRefreshUpstream(m);
          }
        }
        this.bsrTick(now);
      }, 1000);
    }
  }

  private stopTimers(): void {
    const s = this.scheduler ?? this.getScheduler();
    if (this.helloTimer !== null) { s.clear(this.helloTimer); this.helloTimer = null; }
    if (this.expiryTimer !== null) { s.clear(this.expiryTimer); this.expiryTimer = null; }
    if (this.refreshTimer !== null) { s.clear(this.refreshTimer); this.refreshTimer = null; }
  }

  /**
   * RFC 5059 §5: the BSR re-originates every BS_Period; a non-BSR router
   * that has not heard from the current BSR within BS_Timeout drops it and
   * falls back to its own candidacy, if it has one. C-RPs re-advertise on
   * their own period, and learned RP entries age out with their holdtime.
   */
  private bsrTick(now: number): void {
    if (this.isSelfBsr()) {
      const last = this.config.lastBootstrapSentMs;
      if (last === null || now - last >= this.config.bootstrapIntervalSec * 1000) {
        this.originateBootstrap();
      }
    } else if (this.config.currentBsr && this.config.lastBsrHeardMs !== null) {
      if (now - this.config.lastBsrHeardMs > this.config.bootstrapTimeoutSec * 1000) {
        const lost = this.config.currentBsr;
        this.config.currentBsr = null;
        this.config.lastBsrHeardMs = null;
        this.config.learnedRps = [];
        this.getBus().publish({
          topic: 'pim.bsr.changed',
          payload: {
            deviceId: this.host.id, hostname: this.host.getHostname(),
            oldBsrIp: lost.address, newBsrIp: null,
            priority: lost.priority, isSelf: false,
          },
        });
        this.rebindMroutesToRp();
        this.electBsr();
      }
    }

    if (this.config.rpCandidate && this.config.currentBsr) {
      const last = this.config.lastCandidateRpSentMs;
      if (last === null || now - last >= this.config.candidateRpIntervalSec * 1000) {
        this.advertiseCandidateRp();
      }
    }

    for (const [k, entry] of this.config.candidateRps) {
      if (now > entry.expiresMs) this.config.candidateRps.delete(k);
    }
    const stillValid = this.config.learnedRps.filter(
      (r) => r.expiresMs === undefined || now <= r.expiresMs);
    if (stillValid.length !== this.config.learnedRps.length) {
      this.config.learnedRps = stillValid;
      this.rebindMroutesToRp();
    }
  }

  private expireDue(): void {
    const now = this.nowMs();
    const touched = new Set<string>();
    for (const [k, n] of this.config.neighbors) {
      if (now - n.lastHeardMs > n.helloHoldSec * 1000) {
        this.config.neighbors.delete(k);
        this.emitNeighborLost(n, 'timeout');
        touched.add(n.iface);
      }
    }
    for (const iface of touched) {
      const rt = this.config.interfaces.get(iface);
      if (rt) this.recomputeDr(rt);
    }
    for (const [k, m] of this.config.mroutes) {
      if (m.joinExpiryMs === 0) continue;
      if (now > m.joinExpiryMs && m.outgoingInterfaces.size === 0) {
        this.config.mroutes.delete(k);
        this.emitMrout(m, 'expiry');
      }
    }
  }

  private installSubscribers(): void {
    const bus = this.getBus();
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.down',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkDown(e.payload.portName),
    ));
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.up',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkUp(e.payload.portName),
    ));
  }

  private onLinkDown(portName: string): void {
    const rt = this.config.interfaces.get(portName);
    if (!rt) return;
    for (const [k, n] of this.config.neighbors) {
      if (n.iface === portName) {
        this.config.neighbors.delete(k);
        this.emitNeighborLost(n, 'link');
      }
    }
    rt.designatedRouterIp = null;
  }

  private onLinkUp(portName: string): void {
    const rt = this.config.interfaces.get(portName);
    if (!rt || !rt.enabled) return;
    this.transmitHello(rt);
  }
}
