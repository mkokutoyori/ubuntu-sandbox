/**
 * EIGRPEngine — a real, lightweight EIGRP engine on the shared
 * routing foundation, conversing in REAL packets on the wire.
 *
 * Transport (RFC 7868 §4.2): Hellos and Updates are handed to the
 * injected {@link EigrpWire} seam, which encapsulates them in IPv4
 * protocol 88 frames (multicast 224.0.0.10, TTL 1) leaving through
 * the device's real port — they cross cables and switches, and are
 * processed at ingress by the peer's `processPacket`. The engine
 * never touches a peer engine object: a cut cable, a downed port or
 * a powered-off peer genuinely interrupts the conversation.
 *
 * Adjacency (§5.3.4): formed only with a peer whose Hello carries the
 * SAME autonomous system and matching K values, received on an
 * interface activated by a `network` statement (IOS sends and listens
 * only there). Mismatched K values are surfaced like real IOS
 * ('%DUAL-5-NBRCHANGE … K-value mismatch'), never hidden.
 *
 * Topology: Updates advertise the full table with the classic vector
 * metric (path min-bandwidth, cumulative delay) and split horizon —
 * learned prefixes propagate hop by hop like the real distance-vector
 * protocol. Path selection then follows DUAL's feasibility condition:
 * per prefix the lowest-FD path is the successor; an alternate is
 * installed only when its reported distance is below the successor's
 * FD and its own FD fits within `variance × FD(successor)`, capped by
 * `maximum-paths`.
 *
 * Timing (§5.3.1): real timers, on the injected scheduler. Each active
 * interface multicasts a Hello on its own interval (5 s by default,
 * `ip hello-interval eigrp` overrides it), and every neighbour carries a
 * hold timer restarted by each packet heard from it, for the duration
 * THAT neighbour advertised — its expiry is what declares a silent peer
 * down, with nobody at the CLI. Two events cut an adjacency without
 * waiting out the hold time: the interface going down, and a Goodbye
 * (§5.3.6, a Hello with hold time 0) from a peer leaving the AS.
 *
 * A convergence round is therefore a *triggered* update — configuration
 * or a link event — not the protocol's clock. `refreshFromCache()`
 * recomputes routes from already-received Updates without emitting
 * frames, which is what a protocol packet's arrival earns.
 */
import { IPAddress, SubnetMask } from '../core/types';
import { Logger } from '../core/Logger';
import { TimerSet } from '@/events/TimerSet';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import {
  AbstractRoutingProtocolEngine,
} from '../routing/AbstractRoutingProtocolEngine';
import type { RibRoute, RoutingPeer } from '../routing/types';
import type { ConnectedNetwork } from '../routing/RoutingPeerLocator';
import {
  compositeMetric, kValuesMatch,
  EIGRP_DEFAULT_K_VALUES,
  EIGRP_FALLBACK_BANDWIDTH_KBPS, EIGRP_FALLBACK_DELAY_USEC,
  type EigrpKValues,
} from './metric';
import {
  EIGRP_MULTICAST_IP, EIGRP_DEFAULT_HOLD_SEC, EIGRP_DEFAULT_HELLO_SEC,
  type EigrpWire, type EigrpPacket, type EigrpHelloPacket,
  type EigrpUpdatePacket, type EigrpRouteTlv,
} from './packets';

export interface EigrpNetworkStmt {
  /** Network address as configured (classful base). */
  network: string;
  /** Optional wildcard mask (e.g. 0.0.255.255). */
  wildcard?: string;
}

export interface EIGRPConfig {
  asn: number;
  routerId?: string;
  networks: EigrpNetworkStmt[];
  passive: Set<string>;
  autoSummary: boolean;
  variance: number;
  maximumPaths: number;
  redistribute: string[];
  redistributeSources: Set<'static' | 'connected' | 'rip' | 'ospf' | 'bgp'>;
  /** Composite-metric coefficients (`metric weights 0 k1 k2 k3 k4 k5`). */
  kValues: EigrpKValues;
}

/** A prefix this engine really originates, with its link attributes. */
export interface EigrpOriginatedPrefix {
  network: IPAddress;
  mask: SubnetMask;
  /** Effective bandwidth (kbps) of the originating interface. */
  bandwidthKbps?: number;
  /** Delay (µs) of the originating interface. */
  delayUsec?: number;
  external?: boolean;
}

/** EIGRP administrative distances (internal / redistributed-external). */
export const EIGRP_INTERNAL_AD = 90;
export const EIGRP_EXTERNAL_AD = 170;

/** One candidate path to a prefix, with DUAL's two distances. */
interface PathCandidate {
  route: RibRoute;
  /** Feasible distance — full metric through this neighbour. */
  fd: number;
  /** Reported distance — the neighbour's own metric to the prefix. */
  rd: number;
}

/** A neighbor as learned from real Hellos/Updates on the wire. */
interface WireNeighbor {
  ip: string;
  iface: string;
  routerId?: string;
  /**
   * Hold time THIS neighbour advertised in its last Hello (§5.3.1). It is
   * the neighbour's value, not ours: RFC 7868 has each router tell its
   * peers how long to wait before giving up on it, so two ends of a link
   * may legitimately run different hold times.
   */
  holdTimeSec: number;
  /** Convergence round of the last Hello heard (liveness). */
  lastSeenRound: number;
  /** Hold timer token — expiry declares this neighbour down (§5.3.1). */
  holdTimer: symbol | null;
  /** Last full Update received from this neighbor (replace semantics). */
  advertised: EigrpRouteTlv[];
}

function toNum(ip: string): number {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => n >= 0 && n <= 255)
    ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
    : -1;
}

function classfulMaskBits(ip: string): number {
  const first = Number(ip.split('.')[0]);
  if (first < 128) return 8;
  if (first < 192) return 16;
  return 24;
}

/** True if `localIp` is covered by a `network [wildcard]` statement. */
function statementCovers(stmt: EigrpNetworkStmt, localIp: string): boolean {
  const netNum = toNum(stmt.network);
  const ipNum = toNum(localIp);
  if (netNum < 0 || ipNum < 0) return false;
  if (stmt.wildcard) {
    const w = toNum(stmt.wildcard);
    const mask = (~w) >>> 0;
    return (ipNum & mask) === (netNum & mask);
  }
  const bits = classfulMaskBits(stmt.network);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

/** Topology-table entry surfaced by `show ip eigrp topology`. */
export interface EigrpTopoEntry {
  fd: number;
  successorNextHop: IPAddress | null;
  successorIface: string;
  feasibleSuccessors: Array<{
    nextHop: IPAddress | null;
    iface: string;
    rd: number;
    metric: number;
  }>;
}

export class EIGRPEngine extends AbstractRoutingProtocolEngine<EIGRPConfig> {
  readonly protocol = 'eigrp';
  private topo: Map<string, EigrpTopoEntry> = new Map();

  private wire: EigrpWire | null = null;
  private wireNeighbors = new Map<string, WireNeighbor>();
  /** Monotonic convergence-round counter (kept for triggered rounds). */
  private round = 0;

  // ── Timers (RFC 7868 §5.3.1) ───────────────────────────────────────
  private schedulerOverride: IScheduler | null = null;
  /** Inject a scheduler (virtual time in tests, real time in the app). */
  setScheduler(scheduler: IScheduler | null): void {
    this.schedulerOverride = scheduler;
    if (this.isEnabled()) this.armHelloTimers();
  }
  private getScheduler(): IScheduler {
    return this.schedulerOverride ?? getDefaultScheduler();
  }
  private readonly timers = new TimerSet(() => this.getScheduler());
  /** One Hello timer per active interface — the interval is per-interface. */
  private helloTimers = new Map<string, symbol>();
  /** Per-interface `ip hello-interval` / `ip hold-time` overrides. */
  private readonly ifaceTiming = new Map<string, { helloSec?: number; holdSec?: number }>();
  /**
   * Device hook: a neighbour lost to its hold timer changes the routes we
   * contribute, and that has to reach the Router RIB — nobody is running
   * a CLI command at that moment. BGP has the same seam (`setOnRibChange`).
   */
  private onNeighborChange: (() => void) | null = null;
  setOnNeighborChange(cb: () => void): void { this.onNeighborChange = cb; }
  /** Re-entrancy guard: a multicast Hello received mid-round must not
   *  restart the round (the wire is synchronous). */
  private converging = false;
  /** When set, converge without pumping frames or expiring neighbors. */
  private cacheOnly = false;

  getTopologyTable(): ReadonlyMap<string, EigrpTopoEntry> {
    return this.topo;
  }

  protected defaultConfig(): EIGRPConfig {
    return {
      asn: 0, networks: [], passive: new Set(), autoSummary: true,
      variance: 1, maximumPaths: 4, redistribute: [],
      redistributeSources: new Set(),
      kValues: EIGRP_DEFAULT_K_VALUES,
    };
  }

  get asn(): number { return this.config.asn; }

  /** Inject the frame transport (device integration responsibility). */
  setWire(wire: EigrpWire): void { this.wire = wire; }

  /**
   * Compteurs de paquets, alimentés aux points d'émission et de
   * réception réels. `show ip eigrp traffic` les lit ; ils ne sont donc
   * pas une décoration mais une mesure.
   *
   * Query/Reply/SIA restent structurellement à zéro et c'est un FAIT,
   * pas un trou : ce moteur n'a pas d'état Active et n'émet donc jamais
   * de requête diffusée (voir l'en-tête du moteur et `CLAUDE.md`). Les
   * afficher à zéro dit la vérité ; les omettre laisserait croire que le
   * compteur existe ailleurs.
   */
  readonly traffic = {
    helloSent: 0, helloRcvd: 0,
    updateSent: 0, updateRcvd: 0,
    querySent: 0, queryRcvd: 0,
    replySent: 0, replyRcvd: 0,
    ackSent: 0, ackRcvd: 0,
  };

  /**
   * `clear ip eigrp neighbors` : jette les adjacences pour qu'elles se
   * reforment. La table de topologie apprise est vidée avec elles —
   * garder des routes d'un voisin qu'on vient de rejeter serait
   * incohérent.
   */
  clearNeighbors(): void {
    this.wireNeighbors.clear();
    super.converge();
  }

  resetTraffic(): void {
    for (const k of Object.keys(this.traffic) as Array<keyof typeof this.traffic>) {
      this.traffic[k] = 0;
    }
  }

  setRedistribution(source: 'static' | 'connected' | 'rip' | 'ospf' | 'bgp'): void {
    this.config.redistributeSources.add(source);
  }

  removeRedistribution(source: 'static' | 'connected' | 'rip' | 'ospf' | 'bgp'): void {
    this.config.redistributeSources.delete(source);
  }

  /** Connected networks this device really originates into EIGRP. */
  originatedPrefixes(): EigrpOriginatedPrefix[] {
    const out: EigrpOriginatedPrefix[] = [];
    for (const c of this.deviceCtx.connectedNetworks()) {
      if (this.config.passive.has(c.iface)) continue;
      const activated = this.config.networks.some((s) =>
        statementCovers(s, String(c.localIp)));
      if (activated) {
        out.push({
          network: c.network, mask: c.mask,
          bandwidthKbps: c.bandwidthKbps, delayUsec: c.delayUsec,
        });
      } else if (this.config.redistributeSources.has('connected')) {
        out.push({
          network: c.network, mask: c.mask,
          bandwidthKbps: c.bandwidthKbps, delayUsec: c.delayUsec,
          external: true,
        });
      }
    }
    const sources = this.config.redistributeSources;
    const rib = this.deviceCtx.ribRoutes?.() ?? [];
    const seen = new Set(out.map((o) => `${o.network}/${o.mask}`));
    for (const r of rib) {
      const src = r.type === 'default' ? 'static' : r.type;
      if (src !== 'static' && src !== 'rip' && src !== 'ospf' && src !== 'bgp') continue;
      if (!sources.has(src)) continue;
      const key = `${r.network}/${r.mask}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ network: r.network, mask: r.mask, external: true });
    }
    return out;
  }

  // ── Wire conversation ─────────────────────────────────────────────

  /**
   * Interfaces the EIGRP process really runs on: up, addressed, not
   * passive, and covered by a `network` statement — real IOS neither
   * sends nor accepts Hellos anywhere else.
   */
  private activeInterfaces(): ConnectedNetwork[] {
    return this.deviceCtx.connectedNetworks().filter((c) =>
      !this.config.passive.has(c.iface) &&
      this.config.networks.some((s) => statementCovers(s, String(c.localIp))));
  }

  private helloPacket(iface?: string): EigrpHelloPacket {
    return {
      type: 'eigrp', opcode: 'hello',
      asn: this.config.asn,
      kValues: { ...this.config.kValues },
      // What we advertise is OUR hold time on THIS interface — the peer
      // will use it to decide how long to wait for us (§5.3.1).
      holdTimeSec: this.holdSecFor(iface),
      routerId: this.config.routerId,
    };
  }

  // ── Hello / hold timers (RFC 7868 §5.3.1) ──────────────────────────

  /**
   * `ip hello-interval eigrp <as> <sec>` / `ip hold-time eigrp <as> <sec>`.
   * IOS keeps the two independent: raising the Hello interval does NOT
   * raise the hold time, which is precisely how a misconfiguration takes
   * an adjacency down, so this stores exactly what it is told.
   */
  setInterfaceTiming(iface: string, timing: { helloSec?: number; holdSec?: number }): void {
    const cur = this.ifaceTiming.get(iface) ?? {};
    if (timing.helloSec !== undefined) cur.helloSec = timing.helloSec;
    if (timing.holdSec !== undefined) cur.holdSec = timing.holdSec;
    this.ifaceTiming.set(iface, cur);
    if (this.isEnabled()) this.armHelloTimers();
  }

  getInterfaceTiming(iface: string): { helloSec: number; holdSec: number } {
    return { helloSec: this.helloSecFor(iface), holdSec: this.holdSecFor(iface) };
  }

  private helloSecFor(iface?: string): number {
    return (iface ? this.ifaceTiming.get(iface)?.helloSec : undefined)
      ?? EIGRP_DEFAULT_HELLO_SEC;
  }

  private holdSecFor(iface?: string): number {
    return (iface ? this.ifaceTiming.get(iface)?.holdSec : undefined)
      ?? EIGRP_DEFAULT_HOLD_SEC;
  }

  /**
   * One recurring Hello per active interface, at that interface's own
   * interval. Re-armed whenever the set of active interfaces or their
   * timings change; interfaces that dropped out lose their timer.
   */
  private armHelloTimers(): void {
    const active = new Set(this.activeInterfaces().map((c) => c.iface));
    for (const [iface, token] of [...this.helloTimers]) {
      if (!active.has(iface)) {
        this.timers.clear(token);
        this.helloTimers.delete(iface);
      }
    }
    for (const iface of active) {
      // Re-arm unconditionally so an interval change takes effect; a
      // no-op re-arm just restarts the period, as IOS does on config.
      this.timers.clear(this.helloTimers.get(iface));
      this.helloTimers.set(iface, this.timers.setInterval(
        () => this.sendPeriodicHello(iface),
        this.helloSecFor(iface) * 1000,
      ));
    }
  }

  private clearHelloTimers(): void {
    for (const token of this.helloTimers.values()) this.timers.clear(token);
    this.helloTimers.clear();
  }

  /** The periodic Hello itself — discovery and liveness, nothing else. */
  private sendPeriodicHello(iface: string): void {
    if (!this.isEnabled() || !this.wire) return;
    if (!this.activeInterfaces().some((c) => c.iface === iface)) return;
    this.wire.send(iface, EIGRP_MULTICAST_IP, this.helloPacket(iface));
    this.traffic.helloSent++;
  }

  /**
   * (Re)start a neighbour's hold timer on every packet heard from it,
   * for the duration IT advertised. Expiry is the only thing that
   * declares a silent neighbour down — no CLI command required.
   */
  private rearmHoldTimer(n: WireNeighbor): void {
    this.timers.clear(n.holdTimer);
    n.holdTimer = this.timers.setTimeout(
      () => this.holdTimerExpired(n),
      Math.max(1, n.holdTimeSec) * 1000,
    );
  }

  private holdTimerExpired(n: WireNeighbor): void {
    const key = `${n.ip}%${n.iface}`;
    if (this.wireNeighbors.get(key) !== n) return;   // already replaced
    n.holdTimer = null;
    Logger.warn(this.deviceId, 'eigrp:hold-expired',
      `EIGRP-IPv4 ${this.config.asn}: Neighbor ${n.ip} (${n.iface}) `
      + 'is down: holding time expired');
    this.dropNeighbor(n);
    this.recomputeAfterNeighborChange();
  }

  /**
   * An interface going down declares its neighbours down at once — a real
   * router does not sit on a dead link waiting for the hold time to run
   * out (`%DUAL-5-NBRCHANGE … is down: interface down`).
   */
  onInterfaceDown(iface: string): void {
    let lost = false;
    for (const n of [...this.wireNeighbors.values()]) {
      if (n.iface !== iface) continue;
      Logger.warn(this.deviceId, 'eigrp:iface-down',
        `EIGRP-IPv4 ${this.config.asn}: Neighbor ${n.ip} (${n.iface}) `
        + 'is down: interface down');
      this.dropNeighbor(n);
      lost = true;
    }
    this.timers.clear(this.helloTimers.get(iface));
    this.helloTimers.delete(iface);
    if (lost) this.recomputeAfterNeighborChange();
  }

  /**
   * Recompute from the current neighbour set and let the device reprogram
   * the RIB. Called whenever an adjacency comes up or goes down outside a
   * convergence round — a hold timer firing, a Goodbye landing, an
   * interface dropping — because none of those has anyone at the CLI.
   */
  private recomputeAfterNeighborChange(): void {
    this.refreshFromCache();
    this.onNeighborChange?.();
  }

  /**
   * A full convergence round: multicast a Hello out every active
   * interface, then recompute neighbors/routes from what came back.
   * Cable delivery is synchronous, so peers process the Hello, refresh
   * their own view, and answer (unicast Hello + full Update) within
   * this very call — the round is self-sufficient.
   */
  override converge(): void {
    if (this.converging) return;
    if (!this.isEnabled() || !this.wire) { super.converge(); return; }
    this.converging = true;
    try {
      this.round += 1;
      for (const c of this.activeInterfaces()) {
        this.wire.send(c.iface, EIGRP_MULTICAST_IP, this.helloPacket());
        this.traffic.helloSent++;
      }
      super.converge();
    } finally {
      this.converging = false;
    }
  }

  /**
   * Recompute routes from already-received Updates WITHOUT emitting
   * frames or expiring neighbors — the per-forwarding-decision path.
   * Liveness is the job of real convergence rounds; the data path
   * additionally skips routes through disconnected ports (Router FIB).
   */
  refreshFromCache(): void {
    if (this.converging) return;
    this.converging = true;
    this.cacheOnly = true;
    try {
      super.converge();
    } finally {
      this.cacheOnly = false;
      this.converging = false;
    }
  }

  override enable(config?: Partial<EIGRPConfig>): void {
    super.enable(config);
    this.armHelloTimers();
  }

  override disable(): void {
    this.sendGoodbye();
    this.clearHelloTimers();
    for (const n of this.wireNeighbors.values()) this.timers.clear(n.holdTimer);
    this.wireNeighbors.clear();
    this.topo = new Map();
    super.disable();
  }

  /**
   * Goodbye message (RFC 7868 §5.3.6): a router leaving the AS announces
   * it with a Hello carrying hold time 0, so its peers tear the adjacency
   * down at once instead of waiting out the hold time. IOS logs the other
   * side as `is down: Interface Goodbye received`. Without it, an
   * operator typing `no router eigrp` would leave every peer routing
   * through a ghost for the next fifteen seconds.
   */
  private sendGoodbye(): void {
    if (!this.isEnabled() || !this.wire) return;
    for (const c of this.activeInterfaces()) {
      this.wire.send(c.iface, EIGRP_MULTICAST_IP,
        { ...this.helloPacket(c.iface), holdTimeSec: 0 });
      this.traffic.helloSent++;
    }
  }

  /**
   * Release every timer this engine owns. The device calls it when the
   * router is powered off or torn down: a Hello timer outliving its
   * router would keep multicasting from a machine that no longer exists.
   */
  shutdownTimers(): void {
    this.timers.clearAll();
    this.helloTimers.clear();
    for (const n of this.wireNeighbors.values()) n.holdTimer = null;
  }

  /**
   * Ingress for IPv4 protocol-88 payloads delivered by the device.
   * The ONLY path information about a peer enters this engine.
   */
  processPacket(iface: string, srcIp: string, packet: EigrpPacket,
    multicast: boolean): void {
    if (!this.isEnabled() || !this.wire) return;
    // A different AS number is a different EIGRP process — the packet
    // is simply not for us (no adjacency, like real IOS).
    if (packet.asn !== this.config.asn) return;
    // IOS ignores EIGRP packets on passive / non-activated interfaces.
    const local = this.activeInterfaces().find((c) => c.iface === iface);
    if (!local) return;
    if (packet.opcode === 'hello') {
      this.traffic.helloRcvd++;
      this.onHello(iface, srcIp, packet, multicast);
    } else {
      this.traffic.updateRcvd++;
      this.onUpdate(iface, srcIp, packet);
    }
  }

  private onHello(iface: string, srcIp: string, hello: EigrpHelloPacket,
    multicast: boolean): void {
    // Goodbye (§5.3.6): a Hello with hold time 0 says the sender is
    // leaving. Tear the adjacency down now rather than holding a route
    // through it until the hold timer runs out.
    if (hello.holdTimeSec === 0) {
      const leaving = this.wireNeighbors.get(`${srcIp}%${iface}`);
      if (leaving) {
        Logger.warn(this.deviceId, 'eigrp:goodbye',
          `EIGRP-IPv4 ${this.config.asn}: Neighbor ${srcIp} (${iface}) `
          + 'is down: Interface Goodbye received');
        this.dropNeighbor(leaving);
        this.recomputeAfterNeighborChange();
      }
      return;
    }
    // RFC 7868 §5.4 — mismatched K values block the adjacency. Real
    // IOS logs '%DUAL-5-NBRCHANGE … K-value mismatch' on receipt
    // instead of hiding the neighbour silently — make it diagnosable.
    if (!kValuesMatch(this.config.kValues, hello.kValues)) {
      this.bus?.publish({
        topic: 'eigrp.neighbor.k-value-mismatch',
        payload: {
          deviceId: this.deviceId,
          neighbor: srcIp,
          neighborIp: srcIp,
          iface,
          asn: this.config.asn,
          localK: { ...this.config.kValues },
          peerK: { ...hello.kValues },
        },
      });
      Logger.warn(this.deviceId, 'eigrp:k-mismatch',
        `EIGRP-IPv4 ${this.config.asn}: Neighbor ${srcIp} (${iface}) is down: K-value mismatch`);
      const stale = this.wireNeighbors.get(`${srcIp}%${iface}`);
      if (stale) this.dropNeighbor(stale);
      // A real router keeps multicasting its own Hellos regardless —
      // answer so the peer can diagnose the mismatch on ITS side too.
      if (multicast) { this.wire!.send(iface, srcIp, this.helloPacket()); this.traffic.helloSent++; }
      return;
    }

    const key = `${srcIp}%${iface}`;
    const known = this.wireNeighbors.get(key);
    if (known) {
      known.lastSeenRound = Math.max(known.lastSeenRound, this.round);
      known.holdTimeSec = hello.holdTimeSec;
      if (hello.routerId) known.routerId = hello.routerId;
      this.rearmHoldTimer(known);
    } else {
      const fresh: WireNeighbor = {
        ip: srcIp, iface,
        routerId: hello.routerId,
        holdTimeSec: hello.holdTimeSec,
        lastSeenRound: this.round,
        holdTimer: null,
        advertised: [],
      };
      this.wireNeighbors.set(key, fresh);
      this.rearmHoldTimer(fresh);
      // An adjacency coming up is visible at once — `show ip eigrp
      // neighbors` on a real router lists a peer the moment its Hello
      // arrives, not after the next recompute happens to run. Guarded:
      // a no-op while we are already inside a convergence round.
      this.recomputeAfterNeighborChange();
    }

    if (multicast) {
      // The sim analog of "this router's table is already warm from
      // its own periodic Hellos": refresh our own segment view first
      // so the Update we answer with carries a complete topology.
      // Guarded — a no-op when we are the one pumping this round.
      this.converge();
      this.wire!.send(iface, srcIp, this.helloPacket(iface));
      this.traffic.helloSent++;
      this.wire!.send(iface, srcIp, this.buildUpdate(iface));
      this.traffic.updateSent++;
    }
  }

  private onUpdate(iface: string, srcIp: string, update: EigrpUpdatePacket): void {
    // §5.3.2 — Updates are only accepted from established neighbors.
    const known = this.wireNeighbors.get(`${srcIp}%${iface}`);
    if (!known) return;
    known.advertised = [...update.routes];
    // Any packet from a neighbour proves it is alive, not just a Hello.
    this.rearmHoldTimer(known);
  }

  /**
   * Full-table Update for one egress interface: originated prefixes
   * plus learned prefixes re-advertised with the accumulated vector
   * metric (bandwidth = path minimum, delay = path sum). Split horizon
   * (§5.3.2): a prefix whose best path was learned on `egressIface` is
   * never advertised back out of it.
   */
  private buildUpdate(egressIface: string): EigrpUpdatePacket {
    const routes: EigrpRouteTlv[] = [];
    const advertised = new Set<string>();
    for (const pre of this.originatedPrefixes()) {
      const tlv: EigrpRouteTlv = {
        network: String(pre.network),
        prefixLength: pre.mask.toCIDR(),
        bandwidthKbps: pre.bandwidthKbps ?? EIGRP_FALLBACK_BANDWIDTH_KBPS,
        delayUsec: pre.delayUsec ?? EIGRP_FALLBACK_DELAY_USEC,
        external: pre.external === true,
      };
      routes.push(tlv);
      advertised.add(`${tlv.network}/${tlv.prefixLength}`);
    }
    for (const best of this.bestPathsByPrefix().values()) {
      if (best.neighbor.iface === egressIface) continue;  // split horizon
      const key = `${best.accumulated.network}/${best.accumulated.prefixLength}`;
      if (advertised.has(key)) continue;                  // local wins
      advertised.add(key);
      routes.push(best.accumulated);
    }
    return {
      type: 'eigrp', opcode: 'update', asn: this.config.asn, routes,
    };
  }

  /** Local link attributes per interface (metric inputs). */
  private linkAttrs(): Map<string, { bw: number; delay: number }> {
    const out = new Map<string, { bw: number; delay: number }>();
    for (const c of this.deviceCtx.connectedNetworks()) {
      out.set(c.iface, {
        bw: c.bandwidthKbps ?? EIGRP_FALLBACK_BANDWIDTH_KBPS,
        delay: c.delayUsec ?? EIGRP_FALLBACK_DELAY_USEC,
      });
    }
    return out;
  }

  /**
   * Best advertiser per learned prefix, with the vector metric as WE
   * would re-advertise it (ingress link folded in). Pure function of
   * the wire state — usable mid-round for split-horizon decisions.
   */
  private bestPathsByPrefix(): Map<string, {
    neighbor: WireNeighbor; accumulated: EigrpRouteTlv; fd: number;
  }> {
    const k = this.config.kValues;
    const links = this.linkAttrs();
    const best = new Map<string, {
      neighbor: WireNeighbor; accumulated: EigrpRouteTlv; fd: number;
    }>();
    for (const n of this.wireNeighbors.values()) {
      const link = links.get(n.iface) ?? {
        bw: EIGRP_FALLBACK_BANDWIDTH_KBPS,
        delay: EIGRP_FALLBACK_DELAY_USEC,
      };
      for (const tlv of n.advertised) {
        const accBw = Math.min(link.bw, tlv.bandwidthKbps);
        const accDelay = link.delay + tlv.delayUsec;
        const fd = compositeMetric({
          bandwidthKbps: accBw, delayUsec: accDelay,
        }, k);
        const key = `${tlv.network}/${tlv.prefixLength}`;
        const cur = best.get(key);
        if (!cur || fd < cur.fd) {
          best.set(key, {
            neighbor: n, fd,
            accumulated: {
              network: tlv.network, prefixLength: tlv.prefixLength,
              bandwidthKbps: accBw, delayUsec: accDelay,
              external: tlv.external,
            },
          });
        }
      }
    }
    return best;
  }

  private dropNeighbor(n: WireNeighbor): void {
    this.wireNeighbors.delete(`${n.ip}%${n.iface}`);
    this.bus?.publish({
      topic: 'eigrp.neighbor.state-changed',
      payload: {
        deviceId: this.deviceId,
        neighbor: n.ip,
        iface: n.iface,
        oldState: 'Up', newState: 'Down',
        asn: this.config.asn,
      },
    });
  }

  // ── Template-method hooks (driven by wire state, not peer objects) ──

  protected computeNeighbors(_peers: RoutingPeer[]): void {
    // Liveness is not decided here any more. A neighbour goes away when
    // its hold timer expires (§5.3.1) or when the interface carrying it
    // goes down — never because a convergence round happened to run and
    // it had not answered within that same synchronous call. That
    // round-counter rule declared a perfectly live neighbour down the
    // moment anything converged twice without it replying in between.
    const previousIds = new Set(this.neighbors.view().map((v) => v.id));
    const keep = new Set<string>();
    for (const n of this.wireNeighbors.values()) {
      keep.add(n.ip);
      const isNew = !previousIds.has(n.ip);
      this.neighbors.upsert(n.ip, n.ip, n.iface, 'Up', n.routerId);
      if (isNew) {
        this.bus?.publish({
          topic: 'eigrp.neighbor.state-changed',
          payload: {
            deviceId: this.deviceId,
            neighbor: n.ip,
            iface: n.iface,
            oldState: 'Down', newState: 'Up',
            asn: this.config.asn,
          },
        });
      }
    }
    this.neighbors.retainOnly(keep);
  }

  protected computeRoutes(_peers: RoutingPeer[]): RibRoute[] {
    const k = this.config.kValues;
    const links = this.linkAttrs();
    // Real IOS never installs a protocol route for its own connected
    // prefixes — connected (AD 0) always wins.
    const ownNetworks = new Set(this.deviceCtx.connectedNetworks()
      .map((c) => `${c.network}/${c.mask.toCIDR()}`));

    const candidatesByPrefix = new Map<string, PathCandidate[]>();
    for (const n of this.wireNeighbors.values()) {
      const link = links.get(n.iface) ?? {
        bw: EIGRP_FALLBACK_BANDWIDTH_KBPS,
        delay: EIGRP_FALLBACK_DELAY_USEC,
      };
      for (const tlv of n.advertised) {
        const key = `${tlv.network}/${tlv.prefixLength}`;
        if (ownNetworks.has(key)) continue;
        // RD: the neighbor's own metric to the prefix, as advertised.
        const rd = compositeMetric({
          bandwidthKbps: tlv.bandwidthKbps, delayUsec: tlv.delayUsec,
        }, k);
        // FD: RD plus our ingress link (min bandwidth, summed delay).
        const fd = compositeMetric({
          bandwidthKbps: Math.min(link.bw, tlv.bandwidthKbps),
          delayUsec: link.delay + tlv.delayUsec,
        }, k);
        const candidate: PathCandidate = {
          fd, rd,
          route: {
            network: new IPAddress(tlv.network),
            mask: SubnetMask.fromCIDR(tlv.prefixLength),
            nextHop: new IPAddress(n.ip), iface: n.iface,
            protocol: 'eigrp',
            adminDistance: tlv.external ? EIGRP_EXTERNAL_AD : EIGRP_INTERNAL_AD,
            metric: fd,
          },
        };
        const group = candidatesByPrefix.get(key);
        if (group) group.push(candidate);
        else candidatesByPrefix.set(key, [candidate]);
      }
    }
    return this.selectSuccessors(candidatesByPrefix);
  }

  /**
   * DUAL path selection per prefix: best-FD successor first, then
   * feasible alternates (RD < FD(successor)) within the variance
   * multiplier, capped by `maximum-paths`.
   */
  private selectSuccessors(
    candidatesByPrefix: Map<string, PathCandidate[]>,
  ): RibRoute[] {
    const variance = Math.max(1, this.config.variance);
    const maxPaths = Math.max(1, this.config.maximumPaths);
    const routes: RibRoute[] = [];
    const newTopo = new Map<string, EigrpTopoEntry>();
    for (const group of candidatesByPrefix.values()) {
      group.sort((a, b) => a.fd - b.fd);
      const successor = group[0];
      const displayKey =
        `${successor.route.network}/${successor.route.mask.toCIDR()}`;
      newTopo.set(displayKey, {
        fd: successor.fd,
        successorNextHop: successor.route.nextHop,
        successorIface: successor.route.iface,
        feasibleSuccessors: group.slice(1)
          .filter((p) => p.rd < successor.fd)
          .map((p) => ({
            nextHop: p.route.nextHop, iface: p.route.iface,
            rd: p.rd, metric: p.fd,
          })),
      });
      routes.push(successor.route);
      let installed = 1;
      for (const alt of group.slice(1)) {
        if (installed >= maxPaths) break;
        const feasible = alt.rd < successor.fd;
        const withinVariance = alt.fd <= successor.fd * variance;
        if (feasible && withinVariance) {
          routes.push(alt.route);
          installed += 1;
        }
      }
    }
    this.topo = newTopo;
    return routes;
  }
}
