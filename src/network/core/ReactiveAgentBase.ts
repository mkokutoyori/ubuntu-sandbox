/**
 * ReactiveAgentBase — Template Method base for per-device protocol
 * agents driven by the event bus + scheduler (CDP, LLDP, DTP, VTP,
 * UDLD, LACP, STP, IGMP-snooping, …).
 *
 * Owns once the machinery those agents each duplicated (~30–50 lines
 * apiece): the running flag and start/stop lifecycle, bus
 * subscription bookkeeping, link-up/link-down wiring, and named
 * interval timers with scheduler affinity (via the existing
 * {@link TimerSet}, which guarantees each clear() lands on the
 * scheduler that armed the timer).
 *
 * Subclasses keep ONLY protocol substance: what to advertise, how to
 * fold neighbours, when they expire.
 */
import type { IEventBus } from '@/events/EventBus';
import {
  getDefaultScheduler, type IScheduler,
} from '@/events/Scheduler';
import { TimerSet } from '@/events/TimerSet';

/** Minimal host seam shared by every reactive agent. */
export interface ReactiveAgentHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
}

export abstract class ReactiveAgentBase {
  private readonly timerSet = new TimerSet(() => this.getScheduler());
  private readonly namedTimers = new Map<string, symbol>();
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    protected readonly agentHost: ReactiveAgentHost,
    protected readonly getBus: () => IEventBus,
    protected readonly getScheduler: () => IScheduler =
    () => getDefaultScheduler(),
  ) {}

  // ── Hooks ─────────────────────────────────────────────────────────
  /** Whether the protocol is administratively enabled. */
  protected abstract isEnabled(): boolean;
  /** Arm the protocol's interval timers (use scheduleInterval). */
  protected abstract armTimers(): void;
  /** React to a local port coming up (default: nothing). */
  protected onPortLinkUp(_portName: string): void { /* hook */ }
  /** React to a local port going down (default: nothing). */
  protected onPortLinkDown(_portName: string): void { /* hook */ }
  /** Register protocol-specific extra subscriptions (default: none). */
  protected installExtraSubscribers(): void { /* hook */ }

  // ── Lifecycle ─────────────────────────────────────────────────────
  start(): void {
    if (this.running) return;
    this.running = true;
    this.installSubscribers();
    if (this.isEnabled()) this.armTimers();
  }

  /**
   * Detach subscribers + stop timers — used to rebind the agent onto
   * a fresh bus. Protocol state (neighbour tables, …) is preserved so
   * a transient restart does not erase observable state.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    this.stopTimers();
  }

  protected isRunning(): boolean { return this.running; }

  // ── Timers (named, idempotent, scheduler-affine) ─────────────────
  /** Arm a named interval once; re-arming an active name is a no-op. */
  protected scheduleInterval(name: string, fn: () => void, periodMs: number): void {
    if (this.namedTimers.has(name)) return;
    this.namedTimers.set(name, this.timerSet.setInterval(fn, periodMs));
  }

  protected clearInterval(name: string): void {
    const token = this.namedTimers.get(name);
    if (!token) return;
    this.timerSet.clear(token);
    this.namedTimers.delete(name);
  }

  protected stopTimers(): void {
    this.timerSet.clearAll();
    this.namedTimers.clear();
  }

  /** Stop + re-arm — used after a cadence change (`cdp timer`, …). */
  protected restartTimers(): void {
    this.stopTimers();
    if (this.running && this.isEnabled()) this.armTimers();
  }

  /** Arm timers now if the agent runs (used by setEnabled(true)). */
  protected startTimersIfRunning(): void {
    if (this.running) this.armTimers();
  }

  // ── Subscriptions ────────────────────────────────────────────────
  /** Track an unsubscribe handle for automatic teardown on stop(). */
  protected addSubscription(unsubscribe: () => void): void {
    this.unsubscribers.push(unsubscribe);
  }

  private installSubscribers(): void {
    const bus = this.getBus();
    this.addSubscription(bus.subscribeWhere(
      'port.link.up',
      (p) => p.deviceId === this.agentHost.id,
      (e) => this.onPortLinkUp(e.payload.portName),
    ));
    this.addSubscription(bus.subscribeWhere(
      'port.link.down',
      (p) => p.deviceId === this.agentHost.id,
      (e) => this.onPortLinkDown(e.payload.portName),
    ));
    this.installExtraSubscribers();
  }
}
