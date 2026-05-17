/**
 * RmanBusBridge — forwards every internal RmanEvent of one session onto
 * the shared IEventBus, using the `rman.*` topic taxonomy.
 *
 * The bridge subscribes once on the session's RmanObservable<RmanEvent>;
 * each emit is projected to a `RmanDomainEvent` and published via
 * `bus.publish(...)`. Sessions stay self-contained (no IEventBus
 * dependency in the engine/catalog/channel layers) — only the bridge
 * crosses the boundary.
 *
 * Reverse direction (bus → session) is intentionally not wired here:
 * inputs flow through `RmanSession.processLine()`.
 */

import type { IEventBus } from '@/events/EventBus';
import type { RmanObservable } from './reactive/RmanSubject';
import type { RmanEvent } from './core/types';
import type { RmanDomainEvent } from './events';

export class RmanBusBridge {
  private _unsub?: () => void;

  constructor(
    private readonly _sharedBus: IEventBus,
    private readonly _sessionId: string,
    private readonly _events$:   RmanObservable<RmanEvent>,
  ) {}

  start(): void {
    if (this._unsub) return;
    this._unsub = this._events$.subscribe(e => this._forward(e));
  }

  stop(): void {
    this._unsub?.();
    this._unsub = undefined;
  }

  private _forward(e: RmanEvent): void {
    const sessionId = this._sessionId;
    const out: RmanDomainEvent | null = (() => {
      switch (e.type) {
        case 'SESSION_STATE_CHANGED':
          return { topic: 'rman.session.state-changed', payload: { sessionId, from: e.from, to: e.to } };
        case 'CONNECTED':
          return { topic: 'rman.session.connected', payload: { sessionId, dbId: e.dbId, dbName: e.dbName, connectedAt: e.connectedAt } };
        case 'DISCONNECTED':
          return { topic: 'rman.session.disconnected', payload: { sessionId } };
        case 'JOB_STARTED':
          return { topic: 'rman.job.started', payload: { sessionId, jobId: e.jobId, operation: e.operation, startedAt: e.startedAt } };
        case 'JOB_COMPLETED':
          return { topic: 'rman.job.completed', payload: { sessionId, jobId: e.jobId, operation: e.operation, elapsedMs: e.elapsedMs } };
        case 'JOB_FAILED':
          return { topic: 'rman.job.failed', payload: { sessionId, jobId: e.jobId, operation: e.operation, error: e.error, elapsedMs: e.elapsedMs } };
        case 'PROGRESS_UPDATED':
          return { topic: 'rman.job.progress', payload: { sessionId, jobId: e.jobId, stepName: e.stepName, pct: e.pct, message: e.message } };
        case 'BACKUP_PIECE_CREATED':
          return {
            topic: 'rman.backup.piece-created',
            payload: {
              sessionId, jobId: e.jobId, channelId: e.channelId,
              key: e.piece.key, path: e.piece.path, sizeBytes: e.piece.sizeBytes,
              tag: e.piece.tag.label,
            },
          };
        case 'BACKUP_SET_COMPLETE':
          return {
            topic: 'rman.backup.set-complete',
            payload: { sessionId, jobId: e.jobId, bsKey: e.bsKey, tag: e.tag.label, sizeBytes: e.sizeBytes },
          };
        case 'CHANNEL_ALLOCATED':
          return { topic: 'rman.channel.allocated', payload: { sessionId, channelId: e.channelId, sid: e.sid, deviceType: e.deviceType } };
        case 'CHANNEL_RELEASED':
          return { topic: 'rman.channel.released', payload: { sessionId, channelId: e.channelId } };
        case 'CATALOG_UPDATED':
          return { topic: 'rman.catalog.updated', payload: { sessionId, operation: e.operation, bsKey: e.key.bsKey, bpKey: e.key.bpKey } };
        case 'CONFIG_CHANGED':
          return { topic: 'rman.config.changed', payload: { sessionId, key: e.key, oldValue: e.oldValue, newValue: e.newValue } };
        default:
          return null; // events without a shared-bus counterpart stay session-local
      }
    })();
    if (out) this._sharedBus.publish(out);
  }
}
