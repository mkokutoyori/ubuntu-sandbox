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
import {
  getDefaultScheduler, type IScheduler, type TimerHandle,
} from '@/events/Scheduler';
import type { EthernetFrame } from '../core/types';
import type {
  FhrpConfigBase, FhrpGroupBase, FhrpHost, FhrpRecomputeReason,
} from './types';

export abstract class FhrpAgentBase<G extends FhrpGroupBase> {
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

  setPreempt(iface: string, id: number, on: boolean): void {
    const g = this.ensureGroup(iface, id);
    g.preempt = on;
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
  protected sendGuarded(g: G, frame: EthernetFrame): void {
    const key = this.keyOf(g.iface, this.groupId(g));
    if (this.emitting.has(key)) return;
    this.emitting.add(key);
    try { this.host.sendFrame(g.iface, frame); }
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
