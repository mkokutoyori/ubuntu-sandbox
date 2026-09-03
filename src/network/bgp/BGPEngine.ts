/**
 * BGPEngine — a real BGP-4 speaker on the shared routing foundation.
 *
 * Peerings are genuine TCP/179 sessions over the cable (see BgpSession):
 * the engine never reads a neighbour's engine object. A session reaches
 * Established only after a real OPEN/KEEPALIVE handshake with a reciprocally
 * configured peer carrying the right AS; routes are learned exclusively
 * from the UPDATE messages that arrive on Established sessions (Adj-RIB-In),
 * re-advertised to other peers as UPDATEs (Adj-RIB-Out) with eBGP AS_PATH
 * prepending and iBGP split-horizon, and arbitrated per prefix by the full
 * RFC 4271 §9.1.1 best-path comparison (bestPath.ts).
 *
 * The transport is injected as a {@link BgpWire} seam by the device
 * integration (RouterDynamicRouting): `connect()` opens an outbound
 * TCP/179 session, and inbound connections are handed in via
 * {@link BGPEngine.acceptInbound}. No object registry, no peer-engine reads.
 */
import { IPAddress, SubnetMask } from '../core/types';
import { tryIpToUint32, prefixLengthToMaskUint32 } from '../core/ip';
import {
  AbstractRoutingProtocolEngine,
} from '../routing/AbstractRoutingProtocolEngine';
import type {
  NeighborFsmState, RibRoute, RoutingPeer,
} from '../routing/types';
import {
  compareBgpPaths, BGP_DEFAULT_LOCAL_PREF, BGP_WEIGHT_LOCAL,
  type BgpPathCandidate, type BgpOrigin,
} from './bestPath';
import {
  BgpSession, type BgpFsmState,
} from './BgpSession';
import {
  BGP_DEFAULT_CONNECT_RETRY_SEC,
  type BgpUpdateMessage, type BgpNlri, type BgpPathAttributes,
} from './messages';
import { TimerSet } from '@/events/TimerSet';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';

export interface BgpNetworkStmt { network: string; mask: string; }
export interface BgpNeighborCfg {
  ip: string;
  remoteAs?: number;
  activated: boolean;
  /** Cisco `neighbor <ip> weight <n>` — local preference knob. */
  weight?: number;
}
export interface BGPConfig {
  asn: number;
  routerId?: string;
  networks: BgpNetworkStmt[];
  neighbors: Map<string, BgpNeighborCfg>;
  redistribute: string[];
  /** `bgp default local-preference <n>` (RFC 4271 LOCAL_PREF seed). */
  defaultLocalPref: number;
}

/**
 * A live TCP/179 link to a neighbour, provided by the device transport.
 * The engine wraps `transport` in a {@link BgpSession} and uses `localIp`
 * as the next hop it advertises (next-hop-self) and `localIface` for the
 * RIB route it installs from this peer's UPDATEs.
 */
export interface BgpPeerLink {
  readonly neighborIp: string;
  readonly localIp: string;
  readonly localIface: string;
  readonly transport: import('./BgpSession').BgpTransport;
}

/** Transport seam injected by the device (DIP) — real cabled TCP only. */
export interface BgpWire {
  /** Open a TCP/179 session to a configured neighbour, or null if it is
   *  not a reachable cabled BGP peer (state stays Idle). */
  connect(neighborIp: string): BgpPeerLink | null;
}

const EBGP_AD = 20;
const IBGP_AD = 200;

function sameNet(a: string, am: string, b: string): boolean {
  const aNum = tryIpToUint32(a);
  const bNum = tryIpToUint32(b);
  if (aNum === null || bNum === null) return false;
  const mask = prefixLengthToMaskUint32(new SubnetMask(am).toCIDR());
  return (aNum & mask) === (bNum & mask);
}

interface BgpRibEntry {
  network: IPAddress;
  mask: SubnetMask;
  asPath: number[];
  source: 'originated' | 'ebgp' | 'ibgp';
  nextHop: IPAddress | null;
  iface: string;
  weight: number;
  localPref: number;
  origin: BgpOrigin;
  med: number;
  peerRouterId: string;
  peerIp: string;
}

/** RFC 4271 §8.2.2 — the FSM's retry clock and counter, per neighbour. */
interface ConnectRetryState {
  timer: symbol | null;
  counter: number;
}

/** Per-neighbour session state owned by the engine. */
interface PeerSession {
  link: BgpPeerLink;
  session: BgpSession;
  /** Routes learned from this peer (Adj-RIB-In), keyed by `network/mask`. */
  adjRibIn: Map<string, BgpRibEntry>;
  /** Last Adj-RIB-Out we sent this peer (prefix → NLRI + serialised attrs). */
  adjRibOut: Map<string, { nlri: BgpNlri; serial: string }>;
  /** True while we have at least attempted a TCP session this peer. */
  attempted: boolean;
}

export class BGPEngine extends AbstractRoutingProtocolEngine<BGPConfig> {
  readonly protocol = 'bgp';

  private wire: BgpWire | null = null;
  /** Device hook: routes learned/withdrawn outside a local converge (an
   *  UPDATE arrives on a peer's converge) must still reach the Router RIB. */
  private onRibChange: (() => void) | null = null;
  private readonly peers = new Map<string, PeerSession>();
  /** Neighbours we have reached over TCP (link existed) but did not
   *  finish peering with — they read Active rather than Idle. */
  private readonly attempted = new Set<string>();
  /** Re-entrancy guard for the synchronous triggered-update cascade. */
  private propagating = false;
  /** True while {@link refreshFromCache} runs: recompute, never dial. */
  private cacheOnly = false;

  // ── ConnectRetryTimer (RFC 4271 §8.2.2) ────────────────────────────
  private schedulerOverride: IScheduler | null = null;
  /** Inject a scheduler (virtual time in tests, real time in the app). */
  setScheduler(scheduler: IScheduler | null): void { this.schedulerOverride = scheduler; }
  private getScheduler(): IScheduler {
    return this.schedulerOverride ?? getDefaultScheduler();
  }
  private readonly timers = new TimerSet(() => this.getScheduler());
  /** Per-neighbour ConnectRetryTimer + ConnectRetryCounter (§8.2.2). */
  private readonly connectRetry = new Map<string, ConnectRetryState>();
  private connectRetrySec = BGP_DEFAULT_CONNECT_RETRY_SEC;

  /** `neighbor <ip> timers connect-retry <sec>` — the FSM's retry clock. */
  setConnectRetrySec(sec: number): void {
    if (Number.isFinite(sec) && sec > 0) this.connectRetrySec = sec;
  }
  getConnectRetrySec(): number { return this.connectRetrySec; }

  /**
   * ConnectRetryCounter (§8.2.2): how many transport attempts have failed
   * since this peer last came up. `show ip bgp neighbors` reports it, and
   * it is the honest measure of a peering that is not happening.
   */
  getConnectRetryCounter(ip: string): number {
    return this.connectRetry.get(ip)?.counter ?? 0;
  }

  /** True while this neighbour is waiting out its ConnectRetryTimer. */
  isConnectRetryPending(ip: string): boolean {
    return this.connectRetry.get(ip)?.timer !== null
      && this.connectRetry.get(ip)?.timer !== undefined;
  }

  protected defaultConfig(): BGPConfig {
    return {
      asn: 0, networks: [], neighbors: new Map(), redistribute: [],
      defaultLocalPref: BGP_DEFAULT_LOCAL_PREF,
    };
  }

  get asn(): number { return this.config.asn; }
  hasNeighbor(ip: string): BgpNeighborCfg | undefined {
    return this.config.neighbors.get(ip);
  }

  /** Inject the TCP/179 transport seam (device integration). */
  setWire(wire: BgpWire): void { this.wire = wire; }

  /** Notify the device when the Adj-RIB-In changes so it can reflect the
   *  new BGP routes into the Router RIB (push updates outside converge). */
  setOnRibChange(cb: () => void): void { this.onRibChange = cb; }

  private routerId(): string {
    return this.config.routerId ?? '0.0.0.0';
  }

  /** Prefixes really originated: a `network` stmt backed by a real
   *  connected network (BGP advertises only present routes). */
  originatedPrefixes(): Array<{ network: IPAddress; mask: SubnetMask }> {
    const conn = this.deviceCtx.connectedNetworks();
    const out: Array<{ network: IPAddress; mask: SubnetMask }> = [];
    for (const s of this.config.networks) {
      const match = conn.some((c) => sameNet(s.network, s.mask, String(c.network)));
      if (match) {
        out.push({ network: new IPAddress(s.network), mask: new SubnetMask(s.mask) });
      }
    }
    return out;
  }

  // ── lifecycle ──────────────────────────────────────────────────────
  override disable(): void {
    for (const ps of this.peers.values()) ps.session.close();
    this.peers.clear();
    this.shutdownTimers();
    this.attempted.clear();
    super.disable();
  }

  /**
   * Hard clear (RFC 4271 §8.1.2): close the session so the peering falls
   * back to Idle and the ConnectRetryTimer dials again. Returns the peers
   * actually torn down, so a caller can tell "no such peering" from "one
   * was reset".
   */
  resetPeers(matches: (ip: string, cfg: BgpNeighborCfg) => boolean): readonly string[] {
    const reset: string[] = [];
    for (const [ip, ps] of [...this.peers]) {
      const cfg = this.config.neighbors.get(ip);
      if (!cfg || !matches(ip, cfg)) continue;
      ps.session.close();
      this.peers.delete(ip);
      reset.push(ip);
    }
    if (reset.length > 0) this.converge();
    return reset;
  }

  /**
   * Release every ConnectRetryTimer. The device calls it when the router
   * is powered off: a retry clock outliving its chassis would go on
   * dialling from a machine that is not there.
   */
  shutdownTimers(): void {
    this.timers.clearAll();
    this.connectRetry.clear();
  }

  /**
   * Accept an inbound TCP/179 connection (the device listener calls this).
   * Only a configured neighbour is peered with; an unknown source is
   * refused so the initiator never reaches Established (true RFC behaviour:
   * no matching `neighbor` statement ⇒ no peering).
   */
  acceptInbound(link: BgpPeerLink): void {
    if (!this.isEnabled() || !this.config.neighbors.has(link.neighborIp)) {
      link.transport.close();
      return;
    }
    const existing = this.peers.get(link.neighborIp);
    if (existing) {
      // Connection collision (RFC 4271 §6.8): keep an already-Established
      // peering and refuse the new one; otherwise drop the stale/in-progress
      // outbound and accept this inbound so peering can complete.
      if (existing.session.isEstablished()) { link.transport.close(); return; }
      existing.session.close();
      this.peers.delete(link.neighborIp);
    }
    this.startSession(link, false);
  }

  // ── session management ─────────────────────────────────────────────
  private manageSessions(): void {
    // Drop sessions for neighbours no longer configured.
    for (const [ip, ps] of [...this.peers]) {
      if (!this.config.neighbors.has(ip)) {
        ps.session.close();
        this.peers.delete(ip);
        this.clearConnectRetry(ip);
        this.attempted.delete(ip);
      }
    }
    // Forget the retry state of neighbours that were removed outright.
    for (const ip of [...this.connectRetry.keys()]) {
      if (!this.config.neighbors.has(ip)) this.clearConnectRetry(ip);
    }
    for (const ip of this.config.neighbors.keys()) {
      if (this.peers.has(ip)) continue;
      // RFC 4271 §8.2.2: while the ConnectRetryTimer runs, the FSM sits in
      // Active and does NOT re-dial — the timer is what paces attempts.
      // Dialling here on every convergence was the whole problem: with
      // convergence running on every show and every link event, an
      // unreachable neighbour was re-dialled without limit.
      if (this.isConnectRetryPending(ip)) continue;
      this.tryConnect(ip);
    }
  }

  /**
   * One transport attempt (§8.2.2 "initiate a TCP connection"). Success
   * clears the retry clock; failure — no route to the peer, or a peer
   * that refuses to complete the OPEN exchange — starts it, and nothing
   * else will try again until it fires.
   */
  private tryConnect(ip: string): boolean {
    if (!this.isEnabled() || !this.config.neighbors.has(ip)) return false;
    const link = this.wire?.connect(ip) ?? null;
    if (!link) {
      // Not a reachable cabled peer: the FSM never leaves Idle, but it
      // still owes the peer a retry.
      this.armConnectRetry(ip);
      return false;
    }
    this.attempted.add(ip);        // TCP reached; peering may still fail
    this.startSession(link, true);
    if (this.peers.get(ip)?.session.isEstablished()) {
      this.clearConnectRetry(ip);  // §8.2.2: cleared once the peering is up
      return true;
    }
    // The handshake ran and did not establish. `onPeerClosed` may already
    // have armed the timer on the way out — don't count the failure twice.
    if (!this.isConnectRetryPending(ip)) this.armConnectRetry(ip);
    return false;
  }

  private armConnectRetry(ip: string): void {
    const st = this.connectRetry.get(ip) ?? { timer: null, counter: 0 };
    this.timers.clear(st.timer);
    st.counter += 1;
    st.timer = this.timers.setTimeout(() => {
      st.timer = null;
      // ConnectRetryTimer_Expires (§8.2.2): try the transport again.
      if (this.tryConnect(ip)) {
        this.propagate();
        this.onRibChange?.();
      }
    }, this.connectRetrySec * 1000);
    this.connectRetry.set(ip, st);
  }

  private clearConnectRetry(ip: string): void {
    const st = this.connectRetry.get(ip);
    if (!st) return;
    this.timers.clear(st.timer);
    this.connectRetry.delete(ip);
  }

  private startSession(link: BgpPeerLink, initiator: boolean): void {
    const ip = link.neighborIp;
    const cfg = this.config.neighbors.get(ip);
    const ps: PeerSession = {
      link,
      adjRibIn: new Map(),
      adjRibOut: new Map(),
      attempted: true,
      session: new BgpSession(link.transport, {
        localAsn: this.config.asn,
        localRouterId: this.routerId(),
        expectedPeerAsn: cfg?.remoteAs,
      }, {
        onEstablished: () => this.onEstablished(ip),
        onUpdate: (u) => this.onUpdate(ip, u),
        onClose: () => this.onPeerClosed(ip),
      }),
    };
    this.peers.set(ip, ps);
    if (initiator) ps.session.tcpEstablished();
  }

  private onEstablished(ip: string): void {
    // §8.2.2: the ConnectRetryTimer is cleared once the peering is up —
    // and this is the one place that covers both directions, since an
    // inbound connection establishes a peering we never dialled.
    this.clearConnectRetry(ip);
    // Advertise our full table to the freshly-up peer.
    this.advertiseTo(ip);
  }

  private onUpdate(ip: string, update: BgpUpdateMessage): void {
    const ps = this.peers.get(ip);
    if (!ps) return;
    for (const w of update.withdrawn) {
      ps.adjRibIn.delete(`${w.network}/${this.maskOf(w)}`);
    }
    if (update.announced.length > 0 && update.attributes) {
      // §6.3 loop prevention: never accept a path that already lists us.
      if (!update.attributes.asPath.includes(this.config.asn)) {
        for (const nlri of update.announced) {
          const entry = this.toRibEntry(ps, nlri, update.attributes);
          ps.adjRibIn.set(`${entry.network}/${entry.mask}`, entry);
        }
      }
    }
    // A change in what we know triggers re-advertisement to other peers.
    this.propagate(ip);
    this.onRibChange?.();
  }

  private onPeerClosed(ip: string): void {
    const ps = this.peers.get(ip);
    if (!ps) return;
    ps.adjRibIn.clear();
    ps.adjRibOut.clear();
    this.peers.delete(ip);
    // A peering that goes down restarts the ConnectRetryTimer (§8.2.2):
    // the FSM falls back to Active and waits out the clock rather than
    // re-dialling at whatever rate the rest of the system converges.
    if (this.config.neighbors.has(ip) && this.isEnabled()) {
      this.armConnectRetry(ip);
    }
    this.propagate(ip);
    this.onRibChange?.();
  }

  private maskOf(nlri: BgpNlri): SubnetMask {
    return SubnetMask.fromCIDR(nlri.prefixLength);
  }

  private toRibEntry(
    ps: PeerSession, nlri: BgpNlri, attrs: BgpPathAttributes,
  ): BgpRibEntry {
    const peerAsn = ps.session.remoteAsn ?? 0;
    const isEbgp = peerAsn !== this.config.asn;
    const cfg = this.config.neighbors.get(ps.link.neighborIp);
    return {
      network: new IPAddress(nlri.network),
      mask: this.maskOf(nlri),
      asPath: [...attrs.asPath],
      source: isEbgp ? 'ebgp' : 'ibgp',
      // eBGP next-hop is the advertising peer (next-hop-self default here).
      nextHop: new IPAddress(ps.link.neighborIp),
      iface: ps.link.localIface,
      weight: cfg?.weight ?? 0,
      // LOCAL_PREF only travels inside the AS (§5.1.5); eBGP paths take the
      // local default.
      localPref: isEbgp
        ? this.config.defaultLocalPref
        : (attrs.localPref ?? this.config.defaultLocalPref),
      origin: attrs.origin,
      med: attrs.med ?? 0,
      peerRouterId: ps.session.remoteRouterId ?? ps.link.neighborIp,
      peerIp: ps.link.neighborIp,
    };
  }

  // ── route computation (Loc-RIB) ────────────────────────────────────
  /**
   * The Loc-RIB: the single best path per prefix over our originated
   * prefixes plus every Adj-RIB-In, arbitrated by compareBgpPaths.
   */
  private computeLocRib(): BgpRibEntry[] {
    const byPrefix = new Map<string, BgpRibEntry>();
    const consider = (e: BgpRibEntry): void => {
      const key = `${e.network}/${e.mask}`;
      const cur = byPrefix.get(key);
      if (!cur || compareBgpPaths(this.toCandidate(e), this.toCandidate(cur)) < 0) {
        byPrefix.set(key, e);
      }
    };
    for (const pre of this.originatedPrefixes()) {
      consider({
        network: pre.network, mask: pre.mask, asPath: [],
        source: 'originated', nextHop: null, iface: '',
        weight: BGP_WEIGHT_LOCAL, localPref: this.config.defaultLocalPref,
        origin: 'igp', med: 0,
        peerRouterId: this.routerId(), peerIp: '0.0.0.0',
      });
    }
    for (const ps of this.peers.values()) {
      if (!ps.session.isEstablished()) continue;
      for (const e of ps.adjRibIn.values()) consider(e);
    }
    return [...byPrefix.values()];
  }

  private toRibRoute(e: BgpRibEntry): RibRoute {
    return {
      network: e.network, mask: e.mask,
      nextHop: e.nextHop, iface: e.iface,
      protocol: 'bgp',
      adminDistance: e.source === 'ibgp' ? IBGP_AD : EBGP_AD,
      metric: 0,
    };
  }

  private toCandidate(e: BgpRibEntry): BgpPathCandidate {
    return {
      route: this.toRibRoute(e),
      weight: e.weight, localPref: e.localPref,
      locallyOriginated: e.source === 'originated',
      asPath: e.asPath, origin: e.origin, med: e.med,
      isEbgp: e.source === 'ebgp',
      peerRouterId: e.peerRouterId, peerIp: e.peerIp,
    };
  }

  /** Routes contributed to the Router RIB: best learned paths, never a
   *  prefix we already have connected (the local route always wins). */
  private contributedRoutes(): RibRoute[] {
    const ownNetworks = new Set(this.deviceCtx.connectedNetworks()
      .map((c) => `${c.network}/${c.mask}`));
    return this.computeLocRib()
      .filter((e) => e.source !== 'originated'
        && !ownNetworks.has(`${e.network}/${e.mask}`))
      .map((e) => this.toRibRoute(e));
  }

  // ── advertisement (Adj-RIB-Out) ────────────────────────────────────
  /**
   * Compute and send this peer's Adj-RIB-Out as UPDATE messages. Only the
   * delta versus what we last sent is put on the wire (announcements for
   * new/changed prefixes, withdrawals for vanished ones), which bounds the
   * synchronous triggered-update cascade.
   */
  private advertiseTo(ip: string): void {
    const ps = this.peers.get(ip);
    if (!ps || !ps.session.isEstablished()) return;
    const ibgpReceiver = (ps.session.remoteAsn ?? this.config.asn) === this.config.asn;

    const desired = new Map<string, { nlri: BgpNlri; attrs: BgpPathAttributes }>();
    for (const e of this.computeLocRib()) {
      if (ibgpReceiver && e.source === 'ibgp') continue;     // iBGP split-horizon
      if (e.peerIp === ip) continue;            // don't echo a route to its source
      if (e.asPath.includes(ps.session.remoteAsn ?? -1)) continue; // would loop
      const key = `${e.network}/${e.mask}`;
      const attrs: BgpPathAttributes = {
        origin: e.origin,
        asPath: ibgpReceiver ? e.asPath : [this.config.asn, ...e.asPath],
        nextHop: ps.link.localIp,
        med: e.med,
        ...(ibgpReceiver ? { localPref: e.localPref } : {}),
      };
      desired.set(key, {
        nlri: { network: String(e.network), prefixLength: e.mask.toCIDR() },
        attrs,
      });
    }

    // Withdrawals: prefixes previously advertised that we no longer would.
    const withdrawn: BgpNlri[] = [];
    for (const [key, prev] of [...ps.adjRibOut]) {
      if (!desired.has(key)) { withdrawn.push(prev.nlri); ps.adjRibOut.delete(key); }
    }
    // Announcements: new prefixes or changed attributes only.
    for (const [key, { nlri, attrs }] of desired) {
      const serial = JSON.stringify(attrs);
      if (ps.adjRibOut.get(key)?.serial === serial) continue;
      ps.adjRibOut.set(key, { nlri, serial });
      ps.session.sendUpdate({
        type: 'bgp', message: 'update', withdrawn: [], announced: [nlri], attributes: attrs,
      });
    }
    if (withdrawn.length > 0) {
      ps.session.sendUpdate({
        type: 'bgp', message: 'update', withdrawn, announced: [],
      });
    }
  }

  /** Re-advertise to every Established peer except the change's source. */
  private propagate(exceptIp?: string): void {
    if (this.propagating) return;     // guard the synchronous cascade
    this.propagating = true;
    try {
      for (const ip of this.peers.keys()) {
        if (ip === exceptIp) continue;
        this.advertiseTo(ip);
      }
    } finally {
      this.propagating = false;
    }
  }

  /**
   * Recompute contributed routes from the Adj-RIB-In WITHOUT opening
   * sessions or re-advertising — the per-forwarding-decision path, and
   * the counterpart of EIGRPEngine's `refreshFromCache()`.
   *
   * Dialling belongs to a real convergence round (config/show time).
   * Doing it from the data path is what made an unreachable neighbour
   * explode: `manageSessions()` dials it, the SYN dies waiting for ARP,
   * two seconds later the router builds an ICMP unreachable for its own
   * SYN, and routing that ICMP calls straight back in here — one fresh
   * dial per configured neighbour, doubling at every ARP timeout, until
   * the ephemeral pool is drained and every further attempt logs
   * `%TCP-4-WARNINGS: Segment dropped (no-ephemeral)`. A few seconds of
   * that is hundreds of thousands of terminal lines, and a wedged tab.
   */
  refreshFromCache(): void {
    if (this.cacheOnly) return;
    this.cacheOnly = true;
    try {
      super.converge();
    } finally {
      this.cacheOnly = false;
    }
  }

  // ── Template-method hooks ──────────────────────────────────────────
  protected computeNeighbors(_peers: RoutingPeer[]): void {
    if (this.isEnabled() && !this.cacheOnly) {
      this.manageSessions();
      // Re-advertise to every Established peer so a local config change
      // (a new/removed `network`, redistribution) reaches peers that came
      // up earlier — a triggered update. The Adj-RIB-Out delta cache keeps
      // it to genuine changes only.
      this.propagate();
    }
    const keep = new Set<string>();
    for (const [ip, cfg] of this.config.neighbors) {
      keep.add(ip);
      const state = this.neighborState(ip);
      const prev = this.neighbors.view().find((n) => n.id === ip);
      const ps = this.peers.get(ip);
      this.neighbors.upsert(ip, ip, ps ? 'session' : 'unresolved',
        state, cfg.remoteAs !== undefined ? `AS${cfg.remoteAs}` : undefined);
      if (prev?.state !== state) {
        this.publishNeighborState(ip, prev?.state, state, cfg.remoteAs);
      }
    }
    this.neighbors.retainOnly(keep);
  }

  private neighborState(ip: string): NeighborFsmState {
    const ps = this.peers.get(ip);
    if (ps?.session.isEstablished()) return 'Established';
    if (ps) return mapFsm(ps.session.state);
    // No live session: Active if we reached it over TCP but peering failed
    // (e.g. no reciprocal config), Idle if it is not a cabled BGP peer.
    return this.attempted.has(ip) ? 'Active' : 'Idle';
  }

  protected computeRoutes(_peers: RoutingPeer[]): RibRoute[] {
    return this.contributedRoutes();
  }

  // Routes/table read live from the Adj-RIB-In so they are correct
  // regardless of the order in which routers converge between rounds.
  override getContributedRoutes(): RibRoute[] {
    return this.isEnabled() ? this.contributedRoutes() : [];
  }

  /** BGP table rows for `show ip bgp` — real Loc-RIB, no fabrication. */
  getBgpTable(): BgpTableRow[] {
    if (!this.isEnabled()) return [];
    return this.computeLocRib().map((e) => ({
      network: e.network, mask: e.mask, nextHop: e.nextHop,
      asPath: e.asPath, weight: e.weight, localPref: e.localPref,
      origin: 'i' as const,
    })).sort((a, b) => String(a.network).localeCompare(String(b.network)));
  }

  /**
   * Ce que nous avons RÉELLEMENT annoncé à ce voisin — son Adj-RIB-Out,
   * pas la Loc-RIB. Les deux diffèrent dès qu'un filtre ou le split
   * horizon iBGP s'applique, et `show ip bgp neighbors <ip>
   * advertised-routes` demande la première.
   */
  getAdvertisedRoutes(neighborIp: string): BgpTableRow[] {
    const ps = this.peers.get(neighborIp);
    if (!ps) return [];
    const rows: BgpTableRow[] = [];
    for (const { nlri, serial } of ps.adjRibOut.values()) {
      let attrs: BgpPathAttributes | null = null;
      try { attrs = JSON.parse(serial) as BgpPathAttributes; } catch { attrs = null; }
      rows.push({
        network: new IPAddress(nlri.network),
        mask: SubnetMask.fromCIDR(nlri.prefixLength),
        nextHop: attrs?.nextHop ? new IPAddress(String(attrs.nextHop)) : null,
        asPath: attrs?.asPath ?? [],
        weight: 0,
        localPref: attrs?.localPref ?? BGP_DEFAULT_LOCAL_PREF,
        origin: 'i' as const,
      });
    }
    return rows.sort((a, b) => String(a.network).localeCompare(String(b.network)));
  }

  private publishNeighborState(
    ip: string, oldState: string | undefined, newState: string, remoteAs?: number,
  ): void {
    if ((oldState ?? 'Idle') === newState) return;
    this.bus?.publish({
      topic: 'bgp.neighbor.state-changed',
      payload: {
        deviceId: this.deviceId, neighborIp: ip,
        oldState: oldState ?? 'Idle', newState, remoteAs: remoteAs ?? null,
      },
    });
  }
}

/** Map the session FSM to the generic neighbour view (non-established). */
function mapFsm(s: BgpFsmState): NeighborFsmState {
  switch (s) {
    case 'Established': return 'Established';
    case 'OpenConfirm': return 'OpenConfirm';
    case 'OpenSent': return 'OpenSent';
    case 'Connect': return 'Connect';
    // Idle here means "attempted but not up" (the entry exists) — the peer
    // is a cabled speaker we could not finish peering with: Active.
    default: return 'Active';
  }
}

/** One row of the local BGP table (for `show ip bgp`). */
export interface BgpTableRow {
  network: IPAddress;
  mask: SubnetMask;
  nextHop: IPAddress | null;
  asPath: number[];
  weight: number;
  localPref: number;
  origin: 'i';
}
