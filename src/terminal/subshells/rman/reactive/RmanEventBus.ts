/**
 * RmanEventBus — central bus for a single RMAN session.
 *
 * Producers call `emit(event)`; consumers subscribe to typed sub-streams
 * filtered by discriminant. Wraps a private `RmanSubject<RmanEvent>` so
 * the surface is read-only.
 */

import { RmanSubject, type RmanObservable } from './RmanSubject';
import { Operators } from './operators';
import type { RmanEvent } from '../core/types';

export class RmanEventBus {
  private readonly _events$ = new RmanSubject<RmanEvent>();

  readonly events$: RmanObservable<RmanEvent> = this._events$.asObservable();

  readonly sessionState$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'SESSION_STATE_CHANGED' }> =>
      e.type === 'SESSION_STATE_CHANGED'),
  );

  readonly jobStarted$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'JOB_STARTED' }> =>
      e.type === 'JOB_STARTED'),
  );

  readonly jobCompleted$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'JOB_COMPLETED' }> =>
      e.type === 'JOB_COMPLETED'),
  );

  readonly jobFailed$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'JOB_FAILED' }> =>
      e.type === 'JOB_FAILED'),
  );

  readonly progress$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'PROGRESS_UPDATED' }> =>
      e.type === 'PROGRESS_UPDATED'),
  );

  readonly channelAllocated$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'CHANNEL_ALLOCATED' }> =>
      e.type === 'CHANNEL_ALLOCATED'),
  );

  readonly channelReleased$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'CHANNEL_RELEASED' }> =>
      e.type === 'CHANNEL_RELEASED'),
  );

  readonly pieceCreated$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'BACKUP_PIECE_CREATED' }> =>
      e.type === 'BACKUP_PIECE_CREATED'),
  );

  readonly backupSetComplete$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'BACKUP_SET_COMPLETE' }> =>
      e.type === 'BACKUP_SET_COMPLETE'),
  );

  readonly catalogUpdated$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'CATALOG_UPDATED' }> =>
      e.type === 'CATALOG_UPDATED'),
  );

  readonly crosscheckDone$ = this._events$.pipe(
    Operators.ofType((e): e is Extract<RmanEvent, { type: 'CROSSCHECK_DONE' }> =>
      e.type === 'CROSSCHECK_DONE'),
  );

  emit(event: RmanEvent): void { this._events$.next(event); }

  dispose(): void { this._events$.complete(); }
}
