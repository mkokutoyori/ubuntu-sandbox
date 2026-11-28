import type { RedoRecord } from '../storage/RedoStream';

export interface SynchronousRedoAnswer {
  readonly destinations: number;
  readonly acknowledged: number;
  readonly error: string | null;
}

export interface SynchronousRedoPort {
  writeCommit(changes: readonly RedoRecord[], scn: number): SynchronousRedoAnswer;
}

export type CommitSynchronization = 'NONE' | 'OK' | 'DEGRADED' | 'ABORTED';
