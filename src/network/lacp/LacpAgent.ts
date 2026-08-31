import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import {
  type LacpAdminMode, type LacpConfig, type LacpFrame, type LacpPortInfo,
  type LacpPortState, type LacpActorInfo, type LacpGroup, type MarkerFrame,
  type LacpAggregatorSelection,
  MARKER_RESPONSE,
  createDefaultLacpConfig, buildActorState, compareSystemId, partnerWantsFastRate,
  ETHERTYPE_LACP, LACP_SLOW_MAC,
  LACP_FLAG_SYNC, LACP_FLAG_COLLECTING, LACP_FLAG_DISTRIBUTING,
} from './types';
import { MACAddress, type EthernetFrame } from '../core/types';
import type { LinkSendRequest } from '../layers/link/LinkLayer';
import { Logger } from '../core/Logger';

export interface LacpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendOnLink(request: LinkSendRequest): boolean;
  /**
   * A port joined or left an aggregate. STP knows a bundled port by its
   * group name, so the change has to reach it — same host-callback shape
   * DTP and UDLD already use for their own state changes.
   */
  onLacpBundleChanged?(portName: string, groupKey: string, bundled: boolean): void;
}

export class LacpAgent extends ReactiveAgentBase {
  private config: LacpConfig;
  private readonly advertising = new Set<string>();
  private readonly lacpduSent = new Map<string, number>();
  private readonly lacpduReceived = new Map<string, number>();
  private readonly markerReceived = new Map<string, number>();
  private readonly markerResponseSent = new Map<string, number>();
  private readonly markerResponseReceived = new Map<string, number>();

  /** `display lacp statistics` — real per-port LACPDU tx/rx counts. */
  getStatistics(portName: string): { sent: number; received: number } {
    return { sent: this.lacpduSent.get(portName) ?? 0, received: this.lacpduReceived.get(portName) ?? 0 };
  }

  /**
   * Marker Protocol counters, 802.3ad §43.5. Nothing here ORIGINATES a
   * marker — neither IOS, VRP, FortiOS nor the Linux driver does, the
   * kernel saying so in as many words — so `sent` stays zero and the
   * others move only for a marker that really arrived.
   */
  getMarkerStatistics(portName: string): {
    sent: number; received: number; responseSent: number; responseReceived: number;
  } {
    return {
      sent: 0,
      received: this.markerReceived.get(portName) ?? 0,
      responseSent: this.markerResponseSent.get(portName) ?? 0,
      responseReceived: this.markerResponseReceived.get(portName) ?? 0,
    };
  }

  constructor(
    private readonly host: LacpHost,
    getBus: () => IEventBus,
    systemId: string,
    getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    super(host, getBus, getScheduler);
    this.config = createDefaultLacpConfig(systemId);
  }

  getConfig(): Readonly<LacpConfig> { return this.config; }

  setSystemPriority(priority: number): void {
    if (priority < 0 || priority > 65535) return;
    this.config.systemPriority = priority;
    this.recompute();
  }

  /**
   * `lacp port-priority`. Advertised to the partner, which is the
   * field's real job; nothing here arbitrates on it, since this engine
   * bundles every eligible member and has no cap to break ties over.
   */
  setPortPriority(portName: string, priority: number): void {
    const p = this.config.ports.get(portName);
    if (!p || priority < 0 || priority > 65535) return;
    p.portPriority = priority;
    this.advertise(portName);
  }

  setFastRate(on: boolean): void {
    this.config.fastRate = on;
    if (this.config.enabled) {
      this.stopTimers();
      this.armTimers();
    }
  }

  ensureGroup(groupId: number, name?: string, loadBalance?: string): void {
    let g = this.config.groups.get(groupId);
    if (!g) {
      g = {
        name: name ?? `Port-channel${groupId}`,
        loadBalance: loadBalance ?? this.config.loadBalance,
        minLinks: 0, maxLinks: 0, preempt: true, preemptDelay: 30,
        adSelect: 'stable', activeLag: null,
      };
      this.config.groups.set(groupId, g);
    } else {
      if (name) g.name = name;
      if (loadBalance) g.loadBalance = loadBalance;
    }
  }

  setGroupLimits(groupId: number, limits: {
    minLinks?: number; maxLinks?: number; preempt?: boolean; preemptDelay?: number;
    adSelect?: LacpAggregatorSelection;
  }): void {
    this.ensureGroup(groupId);
    const g = this.config.groups.get(groupId)!;
    if (limits.minLinks !== undefined) g.minLinks = limits.minLinks;
    if (limits.maxLinks !== undefined) g.maxLinks = limits.maxLinks;
    if (limits.preempt !== undefined) g.preempt = limits.preempt;
    if (limits.preemptDelay !== undefined) g.preemptDelay = limits.preemptDelay;
    if (limits.adSelect !== undefined) g.adSelect = limits.adSelect;
    this.recompute();
  }

  /**
   * The LAG a port belongs to, 802.1AX §6.4.15 and the kernel's own
   * match in `ad_port_selection_logic`: same actor key, same partner
   * system and same partner key. Two neighbours are two LAGs.
   */
  lagIdOf(p: LacpPortInfo): string {
    if (!p.partner) return `individual:${p.portName}`;
    return `${p.groupId}|${p.partner.systemPriority}`
      + `|${p.partner.systemId.toLowerCase()}|${p.partner.key}`;
  }

  /** The aggregator id `/proc/net/bonding` prints, stable per LAG. */
  aggregatorIdOf(p: LacpPortInfo): number {
    const lags = [...new Set(this.getGroupMembers(p.groupId)
      .filter(m => m.partner !== null)
      .map(m => this.lagIdOf(m)))].sort();
    const rang = lags.indexOf(this.lagIdOf(p));
    return rang < 0 ? p.groupId : rang + 1;
  }

  getGroupLimits(groupId: number): LacpGroup {
    return this.config.groups.get(groupId)
      ?? { name: `Port-channel${groupId}`, loadBalance: this.config.loadBalance,
        minLinks: 0, maxLinks: 0, preempt: true, preemptDelay: 30,
        adSelect: 'stable', activeLag: null };
  }

  addPortToGroup(portName: string, groupId: number, mode: LacpAdminMode): void {
    this.ensureGroup(groupId);
    let p = this.config.ports.get(portName);
    if (!p) {
      p = {
        portName, groupId, mode, portPriority: 32768,
        state: 'standalone', partner: null,
        selected: false, bundled: false, lastRxMs: 0,
        churnActorState: 'none', churnPartnerState: 'none',
        churnActorCount: 0, churnPartnerCount: 0,
        churnActorDeadlineMs: 0, churnPartnerDeadlineMs: 0,
      };
      this.config.ports.set(portName, p);
      if (mode !== 'on') this.armChurn(p);
    } else {
      // Changer le groupe ou le mode REINITIALISE le port (BEGIN), donc
      // relance la surveillance : sans cela, passer de `on` a `active`
      // laissait une machine qui n'avait jamais ete armee.
      const reinitialise = p.groupId !== groupId || p.mode !== mode;
      p.groupId = groupId;
      p.mode = mode;
      if (reinitialise && mode !== 'on') this.armChurn(p);
    }
    this.recompute();
    if (this.config.enabled && mode === 'active') this.advertise(portName);
  }

  removePort(portName: string): void {
    const p = this.config.ports.get(portName);
    if (!p) return;
    if (p.bundled) {
      this.getBus().publish({
        topic: 'lacp.port.unbundled',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: portName, groupId: p.groupId, cause: 'admin-change',
        },
      });
    }
    this.config.ports.delete(portName);
  }

  getPortInfo(portName: string): LacpPortInfo | undefined {
    return this.config.ports.get(portName);
  }

  getGroupMembers(groupId: number): LacpPortInfo[] {
    return Array.from(this.config.ports.values()).filter(p => p.groupId === groupId);
  }

  setLoadBalance(method: string): void {
    this.config.loadBalance = method;
    for (const g of this.config.groups.values()) g.loadBalance = method;
  }

  getLoadBalance(): string {
    return this.config.loadBalance;
  }

  getAllGroups(): Array<{ id: number; name: string; loadBalance: string; members: LacpPortInfo[] }> {
    return Array.from(this.config.groups.entries()).map(([id, g]) => ({
      id, name: g.name, loadBalance: g.loadBalance,
      members: this.getGroupMembers(id),
    }));
  }

  runningConfigInterfaceLines(portName: string): string[] {
    const p = this.config.ports.get(portName);
    if (!p) return [];
    return [`channel-group ${p.groupId} mode ${p.mode}`];
  }

  handleFrame(portName: string, frame: EthernetFrame): void {
    // A stopped agent neither speaks nor processes — otherwise it
    // keeps answering partner LACPDUs and looks alive forever.
    if (!this.isRunning() || !this.config.enabled) return;
    const payload = frame.payload as LacpFrame | MarkerFrame | undefined;
    if (!payload) return;
    if (payload.type === 'lacp-marker') {
      this.handleMarker(portName, payload);
      return;
    }
    if (payload.type !== 'lacp') return;
    const p = this.config.ports.get(portName);
    if (!p) return;
    if (p.mode === 'on') return;
    this.lacpduReceived.set(portName, (this.lacpduReceived.get(portName) ?? 0) + 1);
    const etaitCourant = p.partner !== null && p.state !== 'expired';
    p.partner = { ...payload.actor };
    p.lastRxMs = Date.now();
    // A fresh LACPDU revives an expired port (802.3ad receive machine:
    // EXPIRED → CURRENT); selection below re-bundles it.
    if (p.state === 'expired') p.state = 'standalone';
    // §43.4.17: leaving anything but CURRENT restarts the churn watch.
    if (!etaitCourant) this.armChurn(p);
    this.getBus().publish({
      topic: 'lacp.frame.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName,
        partnerSystemId: payload.actor.systemId,
        partnerKey: payload.actor.key,
      },
    });
    this.recompute();
    this.maybeAdvertiseBack(portName);
  }

  /**
   * 802.3ad §43.5.3.3 : a Marker Information PDU is echoed back with its
   * TLV type changed to Response and every other field left as the
   * requester wrote it — the requester matches its own transaction id.
   * A Response that arrives is counted and answered by nothing, which
   * is what `bond_3ad.c` does and what the standard permits.
   */
  private handleMarker(portName: string, marker: MarkerFrame): void {
    const port = this.config.ports.get(portName);
    if (!port) return;
    if (marker.tlvType === MARKER_RESPONSE) {
      this.markerResponseReceived.set(portName,
        (this.markerResponseReceived.get(portName) ?? 0) + 1);
      return;
    }
    this.markerReceived.set(portName, (this.markerReceived.get(portName) ?? 0) + 1);
    const reponse: MarkerFrame = { ...marker, tlvType: MARKER_RESPONSE };
    const envoye = this.host.sendOnLink({
      iface: portName,
      destination: new MACAddress(LACP_SLOW_MAC),
      etherType: ETHERTYPE_LACP,
      payload: reponse,
    });
    if (envoye) {
      this.markerResponseSent.set(portName,
        (this.markerResponseSent.get(portName) ?? 0) + 1);
    }
  }

  advertise(portName: string): void {
    if (!this.config.enabled) return;
    const port = this.host.getPort(portName);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const p = this.config.ports.get(portName);
    if (!p || p.mode === 'on') return;
    const actor: LacpActorInfo = {
      systemPriority: this.config.systemPriority,
      systemId: this.config.systemId,
      key: p.groupId,
      portPriority: p.portPriority,
      portNumber: this.portNumberFor(portName),
      state: buildActorState(p.mode, p, this.config.fastRate),
    };
    const partner: LacpActorInfo = p.partner ?? {
      systemPriority: 0, systemId: '00:00:00:00:00:00',
      key: 0, portPriority: 0, portNumber: 0, state: 0,
    };
    const payload: LacpFrame = {
      type: 'lacp', subtype: 0x01, version: 0x01,
      actor, partner, collectorMaxDelay: 0,
    };
    if (this.advertising.has(portName)) return;
    this.advertising.add(portName);
    try {
      this.host.sendOnLink({
        iface: portName,
        destination: new MACAddress(LACP_SLOW_MAC),
        etherType: ETHERTYPE_LACP,
        payload,
      });
    } finally { this.advertising.delete(portName); }
    this.lacpduSent.set(portName, (this.lacpduSent.get(portName) ?? 0) + 1);
    this.getBus().publish({
      topic: 'lacp.frame.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, groupId: p.groupId, mode: p.mode,
      },
    });
  }

  private maybeAdvertiseBack(portName: string): void {
    if (this.advertising.has(portName)) return;
    this.advertise(portName);
  }

  private portNumberFor(portName: string): number {
    const idx = this.host.getPorts().findIndex(p => p.getName() === portName);
    return idx + 1;
  }

  protected isEnabled(): boolean { return this.config.enabled; }

  protected armTimers(): void {
    this.scheduleInterval('slow', () => this.tick('slow'), 30_000);
    this.scheduleInterval('fast', () => this.tick('fast'), 1_000);
    this.scheduleInterval('expiry', () => { this.expireDue(); this.churnDue(); }, 1_000);
  }

  /** current_while (802.3ad §43.4.12): 3 × the interval we requested. */
  private rxTimeoutMs(): number {
    return this.config.fastRate ? 3_000 : 90_000;
  }

  /** EXPIRED keeps partner info one short interval before defaulting. */
  private static readonly EXPIRED_GRACE_MS = 3_000;

  /**
   * Receive machine timeouts. Previously a silent partner kept its
   * port bundled forever — a unidirectional failure (peer hung, agent
   * stopped) was never detected as long as the link stayed up.
   */
  private expireDue(): void {
    const now = Date.now();
    for (const p of this.config.ports.values()) {
      if (p.mode === 'on' || !p.partner || p.lastRxMs === 0) continue;
      const port = this.host.getPort(p.portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;
      const elapsed = now - p.lastRxMs;
      if (p.state !== 'expired' && elapsed > this.rxTimeoutMs()) {
        const oldState = p.state;
        const oldBundled = p.bundled;
        p.state = 'expired';
        p.selected = false;
        p.bundled = false;
        this.armChurn(p);
        this.maybeEmitStateChange(p, oldState, oldBundled, 'partner-timeout');
      } else if (p.state === 'expired'
        && elapsed > this.rxTimeoutMs() + LacpAgent.EXPIRED_GRACE_MS) {
        // DEFAULTED: forget the partner entirely.
        const oldState = p.state;
        p.partner = null;
        p.lastRxMs = 0;
        p.state = 'standalone';
        this.maybeEmitStateChange(p, oldState, p.bundled);
        this.recompute();
      }
    }
  }

  /**
   * 802.3ad §43.4.17. Sixty seconds after the port is disturbed, the
   * machine says whether each end reached synchronisation; if it did
   * not, that is a CHURN and it is counted. Once settled the machine
   * stays put until something disturbs the port again — which is why
   * the deadline is cleared rather than rearmed.
   */
  private static readonly CHURN_DETECTION_MS = 60_000;

  private armChurn(p: LacpPortInfo): void {
    const now = Date.now();
    p.churnActorState = 'monitoring';
    p.churnPartnerState = 'monitoring';
    p.churnActorDeadlineMs = now + LacpAgent.CHURN_DETECTION_MS;
    p.churnPartnerDeadlineMs = now + LacpAgent.CHURN_DETECTION_MS;
  }

  private churnDue(): void {
    const now = Date.now();
    for (const p of this.config.ports.values()) {
      if (p.churnActorDeadlineMs !== 0 && now >= p.churnActorDeadlineMs) {
        p.churnActorDeadlineMs = 0;
        if (p.churnActorState === 'monitoring') {
          if (p.selected) {
            p.churnActorState = 'none';
          } else {
            p.churnActorCount += 1;
            p.churnActorState = 'churned';
          }
        }
      }
      if (p.churnPartnerDeadlineMs !== 0 && now >= p.churnPartnerDeadlineMs) {
        p.churnPartnerDeadlineMs = 0;
        if (p.churnPartnerState === 'monitoring') {
          if (((p.partner?.state ?? 0) & LACP_FLAG_SYNC) !== 0) {
            p.churnPartnerState = 'none';
          } else {
            p.churnPartnerCount += 1;
            p.churnPartnerState = 'churned';
          }
        }
      }
    }
  }

  private tick(rate: 'slow' | 'fast'): void {
    for (const p of this.config.ports.values()) {
      const port = this.host.getPort(p.portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;
      if (p.mode !== 'active') continue;
      const rapide = this.config.fastRate
        || (p.partner !== null && partnerWantsFastRate(p.partner.state));
      if (rate === 'slow' && rapide) continue;
      if (rate === 'fast' && !rapide) continue;
      this.advertise(p.portName);
    }
  }

  protected override onPortLinkUp(portName: string): void {
    const p = this.config.ports.get(portName);
    if (!p) return;
    if (p.mode === 'active') this.advertise(portName);
    this.recompute();
  }

  protected override onPortLinkDown(portName: string): void {
    const p = this.config.ports.get(portName);
    if (!p) return;
    const wasBundled = p.bundled;
    p.partner = null;
    p.selected = false;
    if (wasBundled) {
      this.getBus().publish({
        topic: 'lacp.port.unbundled',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: portName, groupId: p.groupId, cause: 'link-down',
        },
      });
    }
    this.recompute();
  }

  private recompute(): void {
    const byGroup = new Map<number, LacpPortInfo[]>();
    for (const p of this.config.ports.values()) {
      const arr = byGroup.get(p.groupId) ?? [];
      arr.push(p);
      byGroup.set(p.groupId, arr);
    }
    for (const [, members] of byGroup) {
      this.runSelection(members);
    }
  }

  /**
   * 802.1AX §6.4.15 : le systeme dont l'identifiant est le plus petit
   * decide, et parmi ses candidats il classe par priorite de port puis
   * par numero de port.
   */
  private static compareCandidates(a: LacpPortInfo, b: LacpPortInfo): number {
    if (a.portPriority !== b.portPriority) return a.portPriority - b.portPriority;
    return a.portName.localeCompare(b.portName, undefined, { numeric: true });
  }

  private holdingSlot = new Set<string>();

  private linkSpeedOf(p: LacpPortInfo): number {
    return this.host.getPort(p.portName)?.getNegotiatedSpeed() ?? 0;
  }

  /**
   * `ad_agg_selection_test` : on prefere d'abord l'agregation dont le
   * partenaire a REPONDU, puis on applique la politique. `count`
   * departage a egalite par la bande passante, ce que le noyau fait par
   * un `fallthrough` explicite.
   */
  private betterAggregate(
    a: { lag: string; ports: LacpPortInfo[] },
    b: { lag: string; ports: LacpPortInfo[] },
    policy: LacpAggregatorSelection,
  ): boolean {
    const repond = (g: { ports: LacpPortInfo[] }) => g.ports.some(p => p.partner !== null);
    if (repond(b) !== repond(a)) return repond(b);
    const bande = (g: { ports: LacpPortInfo[] }) =>
      g.ports.reduce((t, p) => t + this.linkSpeedOf(p), 0);
    if (policy === 'count' && b.ports.length !== a.ports.length) {
      return b.ports.length > a.ports.length;
    }
    return bande(b) > bande(a);
  }

  /**
   * 802.1AX §6.4.15 : deux voisins font DEUX agregations, et une seule
   * porte le trafic. Sans cette regle un serveur cable a deux
   * commutateurs sans MLAG groupait les quatre liens et pontait les
   * deux commutateurs sans qu'aucun protocole ne le dise.
   */
  private selectActiveAggregate(members: LacpPortInfo[]): void {
    if (members.length === 0) return;
    const groupe = this.config.groups.get(members[0].groupId);
    if (!groupe) return;
    const parLag = new Map<string, LacpPortInfo[]>();
    for (const p of members) {
      if (!p.bundled) continue;
      const lag = this.lagIdOf(p);
      const liste = parLag.get(lag) ?? [];
      liste.push(p);
      parLag.set(lag, liste);
    }
    if (parLag.size === 0) { groupe.activeLag = null; return; }

    const candidats = [...parLag.entries()].map(([lag, ports]) => ({ lag, ports }));
    let meilleur = candidats[0];
    for (const c of candidats.slice(1)) {
      if (this.betterAggregate(meilleur, c, groupe.adSelect)) meilleur = c;
    }
    // `stable` ne remplace pas l'active tant qu'elle porte encore.
    const tenante = groupe.activeLag !== null ? parLag.get(groupe.activeLag) : undefined;
    const actif = groupe.adSelect === 'stable' && tenante && tenante.length > 0
      ? groupe.activeLag! : meilleur.lag;
    groupe.activeLag = actif;

    for (const [lag, ports] of parLag) {
      if (lag === actif) continue;
      for (const p of ports) {
        p.state = 'suspended'; p.selected = false; p.bundled = false;
      }
    }
  }

  private applyGroupLimits(members: LacpPortInfo[]): void {
    if (members.length === 0) return;
    const limites = this.config.groups.get(members[0].groupId);
    const min = limites?.minLinks ?? 0;
    const max = limites?.maxLinks ?? 0;
    const candidats = members.filter(p => p.bundled).sort(LacpAgent.compareCandidates);
    if (limites?.preempt === false) {
      const tenants = candidats.filter(p => this.holdingSlot.has(p.portName));
      const autres = candidats.filter(p => !this.holdingSlot.has(p.portName));
      candidats.length = 0;
      candidats.push(...tenants, ...autres);
    }
    const retenus = max > 0 ? candidats.slice(0, max) : candidats;
    this.holdingSlot = new Set(retenus.map(p => p.portName));
    for (const p of candidats) {
      if (retenus.includes(p)) continue;
      p.state = 'standby'; p.selected = false; p.bundled = false;
    }
    if (retenus.length >= Math.max(min, 1)) return;
    for (const p of retenus) {
      p.state = 'standalone'; p.selected = false; p.bundled = false;
    }
  }

  private runSelection(members: LacpPortInfo[]): void {
    const avant = members.map(p => ({ state: p.state, bundled: p.bundled }));
    for (const p of members) {
      const port = this.host.getPort(p.portName);
      // « un câble est branché » ne suffit pas : un membre dont le pair
      // est désactivé ou hors tension ne porte plus rien et doit quitter
      // l'agrégat (docs/PRD-Link-State.md §6).
      const linkUp = !!port && port.isOperationallyUp();
      if (!linkUp) {
        p.state = 'standalone'; p.selected = false; p.bundled = false;
      } else if (p.mode === 'on') {
        p.state = 'bundled'; p.selected = true; p.bundled = true;
      } else if (p.state === 'expired') {
        // Stays out of the aggregate until a fresh LACPDU arrives
        // (handleFrame clears the state) or the partner is defaulted.
        p.selected = false; p.bundled = false;
      } else if (p.partner && p.partner.key === p.groupId) {
        const sameSystem = compareSystemId(
          { priority: this.config.systemPriority, id: this.config.systemId },
          { priority: p.partner.systemPriority, id: p.partner.systemId },
        ) === 0;
        if (sameSystem) {
          p.state = 'standalone'; p.selected = false; p.bundled = false;
        } else {
          p.state = 'bundled'; p.selected = true; p.bundled = true;
        }
      } else {
        p.state = 'standalone'; p.selected = false; p.bundled = false;
      }
    }
    this.selectActiveAggregate(members);
    this.applyGroupLimits(members);
    members.forEach((p, i) => this.maybeEmitStateChange(p, avant[i].state, avant[i].bundled));
  }

  private maybeEmitStateChange(
    p: LacpPortInfo, oldState: LacpPortState, oldBundled: boolean,
    unbundleCause: 'link-down' | 'partner-loss' | 'admin-change' | 'partner-timeout' = 'partner-loss',
  ): void {
    if (oldState !== p.state) {
      this.getBus().publish({
        topic: 'lacp.port.state-changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: p.portName, groupId: p.groupId,
          oldState, newState: p.state,
        },
      });
      Logger.info(this.host.id, 'lacp:state',
        `${this.host.name}: ${p.portName} ${oldState} → ${p.state}`);
    }
    if (oldBundled !== p.bundled) {
      this.host.onLacpBundleChanged?.(p.portName, `${p.groupId}`, p.bundled);
    }
    if (!oldBundled && p.bundled) {
      this.getBus().publish({
        topic: 'lacp.port.bundled',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: p.portName, groupId: p.groupId,
          partnerSystemId: p.partner?.systemId ?? '00:00:00:00:00:00',
        },
      });
    } else if (oldBundled && !p.bundled) {
      this.getBus().publish({
        topic: 'lacp.port.unbundled',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: p.portName, groupId: p.groupId, cause: unbundleCause,
        },
      });
    }
  }
}
