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
 * Timing model (documented simplification): the simulator has no
 * periodic timers here — a convergence round IS the hello interval.
 * Cable delivery being synchronous, every live neighbor refreshes
 * within the round that pumps the Hellos; a neighbor that missed the
 * round is declared down (hold-time analog). `refreshFromCache()`
 * recomputes routes from already-received Updates without emitting
 * frames — the data path stays quiet, like a real router between
 * hello intervals.
 */
import { IPAddress, SubnetMask } from '../core/types';
import { Logger } from '../core/Logger';
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
  EIGRP_MULTICAST_IP, EIGRP_DEFAULT_HOLD_SEC,
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
  holdTimeSec: number;
  /** Convergence round of the last Hello heard (liveness). */
  lastSeenRound: number;
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
  /** Monotonic convergence-round counter (the hello-interval analog). */
  private round = 0;
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

  private helloPacket(): EigrpHelloPacket {
    return {
      type: 'eigrp', opcode: 'hello',
      asn: this.config.asn,
      kValues: { ...this.config.kValues },
      holdTimeSec: EIGRP_DEFAULT_HOLD_SEC,
      routerId: this.config.routerId,
    };
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

  override disable(): void {
    this.wireNeighbors.clear();
    this.topo = new Map();
    super.disable();
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
    if (packet.opcode === 'hello') this.onHello(iface, srcIp, packet, multicast);
    else this.onUpdate(iface, srcIp, packet);
  }

  private onHello(iface: string, srcIp: string, hello: EigrpHelloPacket,
    multicast: boolean): void {
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
      if (multicast) this.wire!.send(iface, srcIp, this.helloPacket());
      return;
    }

    const key = `${srcIp}%${iface}`;
    const known = this.wireNeighbors.get(key);
    if (known) {
      known.lastSeenRound = Math.max(known.lastSeenRound, this.round);
      known.holdTimeSec = hello.holdTimeSec;
      if (hello.routerId) known.routerId = hello.routerId;
    } else {
      this.wireNeighbors.set(key, {
        ip: srcIp, iface,
        routerId: hello.routerId,
        holdTimeSec: hello.holdTimeSec,
        lastSeenRound: this.round,
        advertised: [],
      });
    }

    if (multicast) {
      // The sim analog of "this router's table is already warm from
      // its own periodic Hellos": refresh our own segment view first
      // so the Update we answer with carries a complete topology.
      // Guarded — a no-op when we are the one pumping this round.
      this.converge();
      this.wire!.send(iface, srcIp, this.helloPacket());
      this.wire!.send(iface, srcIp, this.buildUpdate(iface));
    }
  }

  private onUpdate(iface: string, srcIp: string, update: EigrpUpdatePacket): void {
    // §5.3.2 — Updates are only accepted from established neighbors.
    const known = this.wireNeighbors.get(`${srcIp}%${iface}`);
    if (!known) return;
    known.advertised = [...update.routes];
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
    if (!this.cacheOnly) {
      // Hold-time analog: a neighbor that did not refresh during this
      // round's Hello exchange is gone (cut cable, downed port,
      // powered-off or unconfigured peer).
      for (const n of [...this.wireNeighbors.values()]) {
        if (n.lastSeenRound < this.round) this.dropNeighbor(n);
      }
    }
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
