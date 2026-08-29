/**
 * FhrpAgentBase — Template Method base of the FHRP family agents
 * (HSRP, VRRP, GLBP).
 *
 * Owns once what the three agents used to duplicate near-verbatim
 * (~600 lines): lifecycle + bus subscriptions, hello/expiry timer
 * management, the group registry (ensure/get/list/remove + the
 * vip/priority/preempt setters), the emission re-entrancy guard, and
 * the default link-up/link-down reactions.
 *
 * Everything genuinely protocol-specific stays in the subclass:
 * the state machine (`recompute`), the wire format (`advertise`),
 * peer-timeout sweeping (`expireDue`) and which states are allowed
 * to speak (`isSpeakingState`).
 */
import type { IEventBus } from '@/events/EventBus';
import type { Ipv4SendRequest } from '../layers/internet/Ipv4Egress';
import {
  getDefaultScheduler, type IScheduler, type TimerHandle,
} from '@/events/Scheduler';
import {
  IPAddress, MACAddress, ETHERTYPE_ARP,
  type ARPPacket,
} from '../core/types';
import {
  normalizeVirtualMac,
  type FhrpConfigBase, type FhrpDataPlane, type FhrpGroupBase,
  type FhrpHost, type FhrpRecomputeReason,
} from './types';

export abstract class FhrpAgentBase<G extends FhrpGroupBase>
implements FhrpDataPlane {
  protected config: FhrpConfigBase<G> = { enabled: true, groups: new Map() };
  private readonly emitting = new Set<string>();
  private helloTimer: TimerHandle | null = null;
  private expiryTimer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    protected readonly host: FhrpHost,
    protected readonly getBus: () => IEventBus,
    protected readonly getScheduler: () => IScheduler =
    () => getDefaultScheduler(),
  ) {}

  // ── Protocol hooks (the ONLY protocol-specific surface) ──────────
  /** Numeric group identifier (HSRP/GLBP group, VRRP vrid). */
  protected abstract groupId(g: G): number;
  /** Fresh group runtime with the protocol's real defaults. */
  protected abstract makeGroup(iface: string, id: number): G;
  /** Protocol state machine — runs on config/peer/timeout events. */
  protected abstract recompute(g: G, reason: FhrpRecomputeReason): void;
  /** Wire format + emission of one advertisement. */
  protected abstract advertise(g: G): void;
  /** Sweep peers whose hold/master-down interval elapsed. */
  protected abstract expireDue(): void;
  /** States allowed to send periodic packets. */
  protected abstract isSpeakingState(g: G): boolean;
  /** Forget learned peer state when the group's link drops. */
  protected abstract clearPeerState(g: G): void;
  /** Periodic advertisement cadence (ms). */
  protected abstract helloIntervalMs(): number;
  /** Expiry sweep cadence (ms); protocols may probe faster. */
  protected expiryProbeMs(): number { return 1000; }
  /**
   * Virtual MAC to answer ARP for g's VIP when this device is the
   * answering role (HSRP active, VRRP master, GLBP AVG), else null.
   * GLBP uses `requesterIp` for per-client load balancing.
   */
  protected abstract vipArpMac(g: G, requesterIp: string): string | null;
  /** Virtual MACs this device currently forwards for in g. */
  protected abstract ownedVirtualMacs(g: G): string[];
  /** True when this device answers for g's VIP as a local address. */
  protected abstract isVipOwner(g: G): boolean;

  // ── Data plane (FhrpDataPlane) ────────────────────────────────────
  vipArpOwner(iface: string, targetIp: string, requesterIp: string): string | null {
    if (!this.config.enabled) return null;
    for (const g of this.config.groups.values()) {
      if (g.iface !== iface || g.vip !== targetIp) continue;
      const mac = this.vipArpMac(g, requesterIp);
      if (mac) return normalizeVirtualMac(mac);
    }
    return null;
  }

  ownsVirtualMac(iface: string, dstMac: string): boolean {
    if (!this.config.enabled) return false;
    const wanted = normalizeVirtualMac(dstMac);
    for (const g of this.config.groups.values()) {
      if (g.iface !== iface) continue;
      for (const mac of this.ownedVirtualMacs(g)) {
        if (normalizeVirtualMac(mac) === wanted) return true;
      }
    }
    return false;
  }

  ownsVip(iface: string, ip: string): boolean {
    if (!this.config.enabled) return false;
    for (const g of this.config.groups.values()) {
      if (g.iface === iface && g.vip === ip && this.isVipOwner(g)) return true;
    }
    return false;
  }

  /**
   * Gratuitous ARP broadcast after a takeover (RFC 5798 §6.4.1, and
   * the HSRP/GLBP equivalent): sender = VIP with the virtual MAC, so
   * switches re-learn the path and hosts refresh their ARP caches.
   */
  protected gratuitousVipArp(g: G, virtualMac: string): void {
    if (!g.vip) return;
    const port = this.host.getPort(g.iface);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const vmac = new MACAddress(normalizeVirtualMac(virtualMac));
    const vip = new IPAddress(g.vip);
    const garp: ARPPacket = {
      type: 'arp', operation: 'request',
      senderMAC: vmac, senderIP: vip,
      targetMAC: MACAddress.broadcast(), targetIP: vip,
    };
    this.host.sendFrame(g.iface, {
      srcMAC: vmac, dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_ARP, payload: garp,
    });
    this.getBus().publish({
      topic: 'fhrp.gratuitous-arp.sent',
      payload: {
        ...this.deviceRef(),
        iface: g.iface, group: this.groupId(g), vip: g.vip, virtualMac: vmac.toString(),
      },
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────
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

  protected isRunning(): boolean { return this.running; }

  // ── Group registry ────────────────────────────────────────────────
  protected keyOf(iface: string, id: number): string {
    return `${iface}|${id}`;
  }

  getGroup(iface: string, id: number): G | undefined {
    return this.config.groups.get(this.keyOf(iface, id));
  }

  listGroups(): G[] {
    return Array.from(this.config.groups.values()).sort((a, b) =>
      a.iface === b.iface
        ? this.groupId(a) - this.groupId(b)
        : a.iface.localeCompare(b.iface));
  }

  ensureGroup(iface: string, id: number): G {
    const k = this.keyOf(iface, id);
    let g = this.config.groups.get(k);
    if (!g) {
      g = this.makeGroup(iface, id);
      this.config.groups.set(k, g);
    }
    return g;
  }

  removeGroup(iface: string, id: number): void {
    this.config.groups.delete(this.keyOf(iface, id));
  }

  // ── Common setters ───────────────────────────────────────────────
  setVip(iface: string, id: number, vip: string): void {
    const g = this.ensureGroup(iface, id);
    g.vip = vip;
    this.recompute(g, 'config');
    this.advertiseIfDue(g);
  }

  setPriority(iface: string, id: number, priority: number): void {
    const g = this.ensureGroup(iface, id);
    g.priority = priority;
    this.recompute(g, 'priority');
    this.advertiseIfDue(g);
  }

  setPreempt(iface: string, id: number, on: boolean, delaySec?: number): void {
    const g = this.ensureGroup(iface, id);
    g.preempt = on;
    // Le delai voyage AVEC le drapeau parce que la commande n'en fait
    // qu'une : `preempt delay minimum <s>` pose les deux, et les separer
    // ferait exister un instant ou la preemption est armee sans son
    // delai — donc une prise de role que l'operateur n'a pas demandee.
    if (delaySec !== undefined) g.preemptDelaySec = delaySec;
    if (!on) this.clearPreemptDelay(g);
    this.recompute(g, 'preempt');
  }

  // ── Emission machinery ───────────────────────────────────────────
  /** All preconditions to speak: enabled, vip, live link, state. */
  protected shouldEmit(g: G): boolean {
    if (!this.config.enabled || !g.vip) return false;
    const port = this.host.getPort(g.iface);
    if (!port || !port.getIsUp() || !port.isConnected()) return false;
    return this.isSpeakingState(g);
  }

  protected advertiseIfDue(g: G): void {
    if (this.shouldEmit(g)) this.advertise(g);
  }

  /** Re-advertise in response to a peer packet, loop-guarded. */
  protected maybeAdvertiseBack(g: G): void {
    if (this.emitting.has(this.keyOf(g.iface, this.groupId(g)))) return;
    this.advertiseIfDue(g);
  }

  /**
   * Send a frame for a group with re-entrancy protection: a packet
   * we emit can synchronously trigger a peer's reply, which must not
   * recurse into another emission for the same group.
   */
  protected sendGuarded(g: G, request: Omit<Ipv4SendRequest, 'iface'>): void {
    const key = this.keyOf(g.iface, this.groupId(g));
    if (this.emitting.has(key)) return;
    this.emitting.add(key);
    try { this.host.sendIpv4Packet({ ...request, iface: g.iface }); }
    finally { this.emitting.delete(key); }
  }

  /** `{deviceId, hostname}` prefix common to every published event. */
  protected deviceRef(): { deviceId: string; hostname: string } {
    return { deviceId: this.host.id, hostname: this.host.getHostname() };
  }

  /** Interface IP + live-link snapshot used by every state machine. */
  protected linkContext(g: G): { myIp: string; linkUp: boolean } {
    const port = this.host.getPort(g.iface);
    return {
      myIp: port?.getIPAddress()?.toString() ?? '0.0.0.0',
      linkUp: !!port && port.getIsUp() && port.isConnected(),
    };
  }

  // ── Timers ────────────────────────────────────────────────────────
  protected restartTimers(): void {
    if (!this.running) return;
    this.stopTimers();
    this.startTimers();
  }

  private startTimers(): void {
    const s = this.getScheduler();
    this.scheduler = s;
    if (this.helloTimer === null) {
      this.helloTimer = s.setInterval(() => {
        for (const g of this.config.groups.values()) this.advertiseIfDue(g);
      }, this.helloIntervalMs());
    }
    if (this.expiryTimer === null) {
      this.expiryTimer = s.setInterval(
        () => this.expireDue(), this.expiryProbeMs());
    }
  }

  private stopTimers(): void {
    const s = this.scheduler ?? this.getScheduler();
    if (this.helloTimer !== null) { s.clear(this.helloTimer); this.helloTimer = null; }
    if (this.expiryTimer !== null) { s.clear(this.expiryTimer); this.expiryTimer = null; }
  }

  // ── Link-state reactions ─────────────────────────────────────────
  private installSubscribers(): void {
    const bus = this.getBus();
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.up',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkUp(e.payload.portName),
    ));
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.down',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkDown(e.payload.portName),
    ));
  }

  // ── Delai de preemption, commun aux trois familles ───────────────

  /**
   * Le delai de preemption est-il ecoule pour ce groupe ?
   *
   * Il vit sur la BASE parce que les trois familles ont la meme
   * commande sous trois orthographes — `standby <n> preempt delay
   * minimum <s>`, `vrrp <n> preempt delay minimum <s>`, `glbp <n>
   * preempt delay minimum <s>` cote IOS, `preempt-mode timer delay <s>`
   * cote VRP — et la meme decision. En ecrire trois copies, c'etait
   * garantir qu'elles finiraient par differer.
   *
   * Il ne retarde PAS le basculement : quand il n'y a plus d'actif du
   * tout, la reprise est immediate — c'est le chemin de la panne, et le
   * retarder ferait perdre du trafic pour rien. Ce qu'il retarde est la
   * PREEMPTION d'un pair vivant qui parle encore, ce que la
   * documentation donne comme sa raison d'etre : eviter qu'un routeur
   * qui vient de redemarrer ne reprenne le trafic avant que son routage
   * n'ait converge.
   *
   * L'horloge part quand ce routeur devient eligible et est REMISE A
   * ZERO des qu'il cesse de l'etre, sans quoi une eligibilite
   * intermittente finirait par accumuler assez de temps pour preempter
   * sans avoir jamais ete stable une seule seconde.
   */
  protected preemptDelayElapsed(g: G): boolean {
    const delai = g.preemptDelaySec ?? 0;
    if (delai <= 0) { g.preemptEligibleSinceMs = null; return true; }
    const now = Date.now();
    if (g.preemptEligibleSinceMs == null) {
      g.preemptEligibleSinceMs = now;
      // Le minuteur est arme ici, et il faut que quelque chose le
      // reveille : sans ce rendez-vous, la preemption n'aurait lieu qu'a
      // la prochaine annonce recue, donc jamais si le pair se tait.
      this.armPreemptWakeup(g, delai * 1000);
      return false;
    }
    return now - g.preemptEligibleSinceMs >= delai * 1000;
  }

  /** Le groupe cesse d'etre eligible : l'horloge repart de zero. */
  protected clearPreemptDelay(g: G): void {
    g.preemptEligibleSinceMs = null;
  }

  private preemptWakeups = new Map<string, TimerHandle>();

  private armPreemptWakeup(g: G, inMs: number): void {
    const cle = this.keyOf(g.iface, this.groupIdOf(g));
    if (this.preemptWakeups.has(cle)) return;
    const s = this.getScheduler();
    this.preemptWakeups.set(cle, s.setTimeout(() => {
      this.preemptWakeups.delete(cle);
      this.recompute(g, 'preempt');
      this.advertiseIfDue(g);
    }, inMs));
  }

  /**
   * L'identifiant numerique du groupe, pour la cle du minuteur.
   *
   * Les trois familles le nomment differemment (`vrid`, `group`), d'ou
   * ce petit accesseur plutot qu'un champ de plus sur la base.
   */
  protected abstract groupIdOf(g: G): number;

  /** Default reaction; HSRP overrides to honour tracked objects. */
  protected onLinkUp(portName: string): void {
    for (const g of this.config.groups.values()) {
      if (g.iface !== portName) continue;
      this.recompute(g, 'config');
      this.advertiseIfDue(g);
    }
  }

  /** Default reaction; HSRP overrides to honour tracked objects. */
  protected onLinkDown(portName: string): void {
    for (const g of this.config.groups.values()) {
      if (g.iface !== portName) continue;
      this.clearPeerState(g);
      this.recompute(g, 'timeout');
    }
  }
}
