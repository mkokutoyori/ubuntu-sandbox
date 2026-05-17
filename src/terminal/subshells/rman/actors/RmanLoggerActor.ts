/**
 * RmanLoggerActor — projects rman.* events onto the shared 'log' topic.
 *
 * Same shape as Oracle's signal-refresh actors: subscribe to the bus,
 * filter by sessionId, map into a `log` DomainEvent, publish back to
 * the bus. The Logger sink in the project (network/core/Logger) then
 * picks them up automatically.
 *
 * Lifecycle:
 *   const actor = new RmanLoggerActor(bus, sessionId);
 *   actor.start();
 *   …
 *   actor.stop();
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { LogEventPayload } from '@/events/types';
import type {
  RmanSessionStateChangedPayload, RmanConnectedPayload, RmanDisconnectedPayload,
  RmanJobStartedPayload, RmanJobCompletedPayload, RmanJobFailedPayload,
  RmanBackupPieceCreatedPayload, RmanChannelAllocatedPayload,
  RmanChannelReleasedPayload, RmanCatalogUpdatedPayload, RmanConfigChangedPayload,
} from '../events';

export class RmanLoggerActor {
  private subs: Unsubscribe[] = [];

  constructor(
    private readonly bus:       IEventBus,
    private readonly sessionId: string,
  ) {}

  start(): void {
    if (this.subs.length > 0) return;
    const me = this.sessionId;
    const source = `rman.${me}`;

    const log = (level: LogEventPayload['level'], event: string, message: string, data?: unknown) => {
      this.bus.publish({
        topic: 'log',
        payload: { level, source, event, message, data },
      });
    };

    const scoped = <P extends { sessionId: string }>(handler: (p: P) => void) =>
      (event: { payload: unknown }) => {
        const p = event.payload as P;
        if (p.sessionId !== me) return;
        handler(p);
      };

    this.subs.push(
      this.bus.subscribe('rman.session.state-changed', scoped<RmanSessionStateChangedPayload>(p =>
        log('info', 'session.state-changed', `RMAN session: ${p.from} → ${p.to}`, p))),
      this.bus.subscribe('rman.session.connected', scoped<RmanConnectedPayload>(p =>
        log('info', 'session.connected', `connected to target database: ${p.dbName} (DBID=${p.dbId})`, p))),
      this.bus.subscribe('rman.session.disconnected', scoped<RmanDisconnectedPayload>(_p =>
        log('info', 'session.disconnected', 'Recovery Manager complete', _p))),
      this.bus.subscribe('rman.job.started', scoped<RmanJobStartedPayload>(p =>
        log('info', 'job.started', `${p.operation} ${p.jobId} started`, p))),
      this.bus.subscribe('rman.job.completed', scoped<RmanJobCompletedPayload>(p =>
        log('info', 'job.completed', `${p.operation} ${p.jobId} completed (elapsed ${p.elapsedMs}ms)`, p))),
      this.bus.subscribe('rman.job.failed', scoped<RmanJobFailedPayload>(p =>
        log('error', 'job.failed', `RMAN-${p.error.code}: ${p.error.message}`, p))),
      this.bus.subscribe('rman.backup.piece-created', scoped<RmanBackupPieceCreatedPayload>(p =>
        log('info', 'backup.piece-created', `piece handle=${p.path} tag=${p.tag}`, p))),
      this.bus.subscribe('rman.channel.allocated', scoped<RmanChannelAllocatedPayload>(p =>
        log('info', 'channel.allocated', `allocated channel: ${p.channelId} (SID=${p.sid}, type=${p.deviceType})`, p))),
      this.bus.subscribe('rman.channel.released', scoped<RmanChannelReleasedPayload>(p =>
        log('info', 'channel.released', `released channel: ${p.channelId}`, p))),
      this.bus.subscribe('rman.catalog.updated', scoped<RmanCatalogUpdatedPayload>(p =>
        log('debug', 'catalog.updated', `catalog ${p.operation} bsKey=${p.bsKey} bpKey=${p.bpKey}`, p))),
      this.bus.subscribe('rman.config.changed', scoped<RmanConfigChangedPayload>(p =>
        log('info', 'config.changed', `${p.key}: ${p.oldValue} → ${p.newValue}`, p))),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs = [];
  }
}
