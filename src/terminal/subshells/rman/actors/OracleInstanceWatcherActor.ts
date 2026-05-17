/**
 * OracleInstanceWatcherActor — cross-cutting reactive bridge that
 * subscribes to `oracle.instance.state-changed` on the shared bus and
 * disposes the bound RmanSession when the watched device's instance
 * leaves a usable lifecycle state.
 *
 * Mirrors what would happen against a real Oracle target: the network
 * channel dies and the RMAN client exits. Here we map the same event
 * onto an explicit session.dispose() so the active job (if any) emits
 * JOB_FAILED via the engine's regular shutdown path, the bus bridge
 * forwards the disconnect, and downstream consumers (LoggerActor,
 * SignalRefreshActor, UI) react reactively without any imperative
 * coupling.
 *
 * Lifecycle:
 *   const w = new OracleInstanceWatcherActor(bus, deviceId, session);
 *   w.start();
 *   …
 *   w.stop();
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { IRmanSession } from '../session/IRmanSession';

type InstanceState = 'SHUTDOWN' | 'NOMOUNT' | 'MOUNT' | 'OPEN';

/** A watched session is dropped when the instance enters one of these states. */
const FATAL_STATES = new Set<InstanceState>(['SHUTDOWN']);

export class OracleInstanceWatcherActor {
  private _unsub?: Unsubscribe;

  constructor(
    private readonly _bus:      IEventBus,
    private readonly _deviceId: string,
    private readonly _session:  IRmanSession,
  ) {}

  start(): void {
    if (this._unsub) return;
    this._unsub = this._bus.subscribe('oracle.instance.state-changed', e => {
      const p = e.payload as { deviceId: string; newState: InstanceState };
      if (p.deviceId !== this._deviceId) return;
      if (!FATAL_STATES.has(p.newState))  return;
      this._session.dispose();
    });
  }

  stop(): void {
    this._unsub?.();
    this._unsub = undefined;
  }
}
