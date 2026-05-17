/**
 * RmanSignalRefreshActor — keeps a RmanSignalStore in sync with the
 * `rman.*` events of a single session, sourced from the shared
 * `IEventBus`.
 *
 * Mirrors OracleSignalRefreshActor: subscribes once, filters by
 * sessionId, mutates the writable store. Engines stay decoupled from
 * the read-model — they only publish facts.
 *
 * Lifecycle:
 *   const a = new RmanSignalRefreshActor(bus, sessionId, store);
 *   a.start();
 *   …
 *   a.stop();
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type {
  RmanSessionStateChangedPayload, RmanConnectedPayload, RmanDisconnectedPayload,
  RmanJobStartedPayload, RmanJobCompletedPayload, RmanJobFailedPayload,
  RmanProgressUpdatedPayload, RmanBackupPieceCreatedPayload,
  RmanChannelAllocatedPayload, RmanChannelReleasedPayload,
  RmanCatalogUpdatedPayload,
} from '../events';
import type { RmanSignalStore } from '../RmanSignalStore';

export class RmanSignalRefreshActor {
  private subs: Unsubscribe[] = [];

  constructor(
    private readonly bus:       IEventBus,
    private readonly sessionId: string,
    private readonly store:     RmanSignalStore,
  ) {}

  start(): void {
    if (this.subs.length > 0) return;
    const me = this.sessionId;

    const scoped = <P extends { sessionId: string }>(handler: (p: P) => void) =>
      (event: { payload: unknown }) => {
        const p = event.payload as P;
        if (p.sessionId !== me) return;
        handler(p);
      };

    this.subs.push(
      this.bus.subscribe('rman.session.state-changed', scoped<RmanSessionStateChangedPayload>(p => {
        this.store.session.update(cur => ({ ...cur, sessionId: p.sessionId, state: p.to }));
      })),
      this.bus.subscribe('rman.session.connected', scoped<RmanConnectedPayload>(p => {
        this.store.session.update(cur => ({
          ...cur, sessionId: p.sessionId, dbName: p.dbName, connectedAt: p.connectedAt,
        }));
      })),
      this.bus.subscribe('rman.session.disconnected', scoped<RmanDisconnectedPayload>(p => {
        this.store.session.update(cur => ({ ...cur, state: 'DISCONNECTED', connectedAt: null }));
        this.store.activeJob.set(null);
        this.store.activeChannels.set(new Set());
        void p;
      })),

      this.bus.subscribe('rman.job.started', scoped<RmanJobStartedPayload>(p => {
        this.store.activeJob.set({
          jobId: p.jobId, operation: p.operation, startedAt: p.startedAt,
          stepName: '', pct: 0, message: '',
        });
        this.store.metrics.update(m => ({ ...m, jobsStarted: m.jobsStarted + 1 }));
      })),

      this.bus.subscribe('rman.job.completed', scoped<RmanJobCompletedPayload>(_p => {
        this.store.activeJob.set(null);
        this.store.metrics.update(m => ({ ...m, jobsCompleted: m.jobsCompleted + 1 }));
      })),

      this.bus.subscribe('rman.job.failed', scoped<RmanJobFailedPayload>(_p => {
        this.store.activeJob.set(null);
        this.store.metrics.update(m => ({ ...m, jobsFailed: m.jobsFailed + 1 }));
      })),

      this.bus.subscribe('rman.job.progress', scoped<RmanProgressUpdatedPayload>(p => {
        const j = this.store.activeJob.get();
        if (!j || j.jobId !== p.jobId) return;
        this.store.activeJob.set({ ...j, stepName: p.stepName, pct: p.pct, message: p.message });
      })),

      this.bus.subscribe('rman.backup.piece-created', scoped<RmanBackupPieceCreatedPayload>(p => {
        this.store.metrics.update(m => ({
          ...m,
          piecesCreated:      m.piecesCreated + 1,
          totalBytesBackedUp: m.totalBytesBackedUp + p.sizeBytes,
        }));
      })),

      this.bus.subscribe('rman.channel.allocated', scoped<RmanChannelAllocatedPayload>(p => {
        const next = new Set(this.store.activeChannels.get());
        next.add(p.channelId);
        this.store.activeChannels.set(next);
        this.store.metrics.update(m => ({ ...m, channelsAllocated: m.channelsAllocated + 1 }));
      })),

      this.bus.subscribe('rman.channel.released', scoped<RmanChannelReleasedPayload>(p => {
        const next = new Set(this.store.activeChannels.get());
        next.delete(p.channelId);
        this.store.activeChannels.set(next);
        this.store.metrics.update(m => ({ ...m, channelsReleased: m.channelsReleased + 1 }));
      })),

      this.bus.subscribe('rman.catalog.updated', scoped<RmanCatalogUpdatedPayload>(p => {
        if (p.operation === 'DELETE') {
          this.store.metrics.update(m => ({ ...m, piecesDeleted: m.piecesDeleted + 1 }));
        }
      })),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs = [];
  }
}
