/**
 * Reactive aggregations — derived behaviour streams computed off the bus.
 *
 * Each helper subscribes once to the source events$ stream and pushes a
 * fresh snapshot into its RmanBehaviorSubject. Consumers see the latest
 * value on subscribe and every change after.
 *
 * These are *derived* state — no producer mutates them directly. They
 * exist so the SubShell + future UI hooks can read aggregate session
 * facts (current job, allocated channels, byte totals) without
 * shadow-tracking events on their own.
 */

import { RmanBehaviorSubject } from './RmanBehaviorSubject';
import type { RmanObservable } from './RmanSubject';
import type { RmanEvent } from '../core/types';

export interface SessionMetrics {
  readonly jobsStarted:        number;
  readonly jobsCompleted:      number;
  readonly jobsFailed:         number;
  readonly piecesCreated:      number;
  readonly piecesDeleted:      number;
  readonly totalBytesBackedUp: number;
  readonly channelsAllocated:  number;
  readonly channelsReleased:   number;
}

export const EMPTY_METRICS: SessionMetrics = Object.freeze({
  jobsStarted: 0, jobsCompleted: 0, jobsFailed: 0,
  piecesCreated: 0, piecesDeleted: 0, totalBytesBackedUp: 0,
  channelsAllocated: 0, channelsReleased: 0,
});

/** Bundle of all derived observables — built once per session. */
export interface ReactiveAggregations {
  readonly metrics$:        RmanObservable<SessionMetrics>;
  readonly activeJob$:      RmanObservable<string | null>;
  readonly activeChannels$: RmanObservable<ReadonlySet<string>>;
  dispose(): void;
}

export function createAggregations(events$: RmanObservable<RmanEvent>): ReactiveAggregations {
  const metrics$        = new RmanBehaviorSubject<SessionMetrics>(EMPTY_METRICS);
  const activeJob$      = new RmanBehaviorSubject<string | null>(null);
  const activeChannels$ = new RmanBehaviorSubject<ReadonlySet<string>>(new Set());

  const unsub = events$.subscribe(e => {
    const m = metrics$.value;
    switch (e.type) {
      case 'JOB_STARTED':
        activeJob$.next(e.jobId);
        metrics$.next({ ...m, jobsStarted: m.jobsStarted + 1 });
        break;
      case 'JOB_COMPLETED':
        activeJob$.next(null);
        metrics$.next({ ...m, jobsCompleted: m.jobsCompleted + 1 });
        break;
      case 'JOB_FAILED':
        activeJob$.next(null);
        metrics$.next({ ...m, jobsFailed: m.jobsFailed + 1 });
        break;
      case 'BACKUP_PIECE_CREATED':
        metrics$.next({
          ...m,
          piecesCreated:      m.piecesCreated + 1,
          totalBytesBackedUp: m.totalBytesBackedUp + e.piece.sizeBytes,
        });
        break;
      case 'CATALOG_UPDATED':
        if (e.operation === 'DELETE') {
          metrics$.next({ ...m, piecesDeleted: m.piecesDeleted + 1 });
        }
        break;
      case 'CHANNEL_ALLOCATED': {
        const next = new Set(activeChannels$.value);
        next.add(e.channelId);
        activeChannels$.next(next);
        metrics$.next({ ...m, channelsAllocated: m.channelsAllocated + 1 });
        break;
      }
      case 'CHANNEL_RELEASED': {
        const next = new Set(activeChannels$.value);
        next.delete(e.channelId);
        activeChannels$.next(next);
        metrics$.next({ ...m, channelsReleased: m.channelsReleased + 1 });
        break;
      }
    }
  });

  return {
    metrics$:        metrics$.asObservable(),
    activeJob$:      activeJob$.asObservable(),
    activeChannels$: activeChannels$.asObservable(),
    dispose() {
      unsub();
      metrics$.complete();
      activeJob$.complete();
      activeChannels$.complete();
    },
  };
}
