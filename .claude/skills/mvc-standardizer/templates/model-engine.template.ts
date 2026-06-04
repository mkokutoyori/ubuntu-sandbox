/**
 * TEMPLATE — Model / Actor (a protocol engine).
 *
 * Copy to `src/network/<feature>/<Feature>Engine.ts` and replace `Lldp`/`lldp`.
 * Modelled on `src/network/ospf/OSPFEngine.ts`.
 *
 * RESPONSIBILITIES (and nothing else)
 *  - Own the mutable domain state + the business logic.
 *  - Own a PRIVATE SignalStore; expose `observables` (read-only Signals).
 *  - PUBLISH domain events on the EventBus. Never call another Actor directly.
 *  - Schedule ALL timers through the injected Scheduler. No native timers.
 *  - Delegate every "state → VM" transform to the pure `projectXxx` functions.
 *
 * FORBIDDEN imports here: react, @/store/*, @/components/*, native setTimeout/Interval.
 */

import { getDefaultEventBus, type IEventBus, type Unsubscribe } from '@/events/EventBus';
import { RealTimeScheduler, type IScheduler } from '@/events/Scheduler';
import {
  LldpSignalStore,
  makeLldpObservables,
  projectNeighbors,
  projectRuntime,
  type LldpObservables,
} from './observables';

interface LldpNeighborRecord {
  localPort: string;
  chassisId: string;
  remotePortId: string;
  systemName: string;
  ttlSeconds: number;
  learnedAtMs: number;
}

export class LldpEngine {
  private readonly deviceId: string;
  private readonly bus: IEventBus;
  private readonly scheduler: IScheduler;

  // ── Mutable domain state (private) ──────────────────────────────────────
  private enabled = false;
  private txCount = 0;
  private rxCount = 0;
  private readonly neighbors = new Map<string, LldpNeighborRecord>();

  // ── Reactive surface ────────────────────────────────────────────────────
  /** Engine-private writable signal store. */
  private readonly signalStore = new LldpSignalStore();
  /** Read-only observables consumed by hooks/tests. */
  readonly observables: LldpObservables = makeLldpObservables(this.signalStore);

  // ── Bus actor (drives signal refresh) ────────────────────────────────────
  private refreshActor: LldpSignalRefreshActor | null = null;
  private txTimer: number | null = null;

  constructor(
    deviceId: string,
    bus: IEventBus = getDefaultEventBus(),
    scheduler: IScheduler = new RealTimeScheduler(),
  ) {
    this.deviceId = deviceId;
    this.bus = bus;
    this.scheduler = scheduler;
  }

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.refreshActor = new LldpSignalRefreshActor(this.bus, this);
    // ALL timers go through the Scheduler (deterministic in tests).
    this.txTimer = this.scheduler.setInterval(() => this.advertise(), 30_000);
    this.bus.publish({ topic: 'device.power-on', payload: { id: this.deviceId } });
    this.refreshAll();
  }

  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.txTimer !== null) this.scheduler.clear(this.txTimer);
    this.refreshActor?.dispose();
    this.refreshActor = null;
    this.refreshRuntimeSignal();
  }

  /** Domain mutation: learn/refresh a neighbor, then PUBLISH (don't call others). */
  onAdvertisementReceived(rec: Omit<LldpNeighborRecord, 'learnedAtMs'>): void {
    this.rxCount++;
    this.neighbors.set(`${rec.localPort}:${rec.chassisId}`, {
      ...rec,
      learnedAtMs: this.scheduler.now(),
    });
    this.bus.publish({
      // topic must be declared in src/events/types.ts (DomainEvent union)
      topic: 'lldp.neighbor.learned' as never,
      payload: { deviceId: this.deviceId, chassisId: rec.chassisId } as never,
    });
    // The refresh actor reacts to the published event; no manual refresh needed.
  }

  private advertise(): void {
    this.txCount++;
    this.bus.publish({ topic: 'lldp.advertisement.sent' as never, payload: { deviceId: this.deviceId } as never });
    this.refreshRuntimeSignal();
  }

  // ── Read-model refresh (driven by the SignalRefreshActor) ────────────────
  // Thin wrappers: they ONLY call the pure projections and `signal.set(...)`.
  // No transform logic lives here.

  _refreshNeighborSignal(): void {
    this.signalStore.neighbors.set(
      projectNeighbors(this.neighbors.values(), this.scheduler.now()),
    );
  }

  refreshRuntimeSignal(): void {
    this.signalStore.runtime.set(
      projectRuntime({
        enabled: this.enabled,
        txCount: this.txCount,
        rxCount: this.rxCount,
        neighborCount: this.neighbors.size,
      }),
    );
  }

  private refreshAll(): void {
    this._refreshNeighborSignal();
    this.refreshRuntimeSignal();
  }
}

/**
 * Refresh Actor — subscribes to the bus and republishes the engine's signals
 * after relevant mutations. Keeps the engine free of subscription wiring and
 * makes the "what triggers a refresh" policy explicit and testable.
 */
export class LldpSignalRefreshActor {
  private readonly subs: Unsubscribe[] = [];

  constructor(bus: IEventBus, engine: LldpEngine) {
    this.subs.push(
      bus.subscribe('lldp.neighbor.learned' as never, () => {
        engine._refreshNeighborSignal();
        engine.refreshRuntimeSignal();
      }),
    );
    // Subscribe to every topic that should refresh a read-model.
  }

  dispose(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
  }
}
