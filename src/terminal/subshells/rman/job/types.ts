/**
 * Job types — JobStep / RmanJob / JobResult / JobError.
 */

import type { RmanOperation } from '../core/types';
import type { RmanError } from '../core/RmanError';

export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface JobStep {
  readonly name:    string;
  readonly pct:     number;
  readonly message: string;
}

export interface RmanJob {
  readonly id:        string;
  readonly operation: RmanOperation;
  readonly steps:     ReadonlyArray<JobStep>;
  readonly startedAt: number;
  /** Optional context — e.g. tablespace name for BACKUP TABLESPACE. */
  readonly params?:   Readonly<Record<string, string>>;
}

export interface JobResult {
  readonly jobId:     string;
  readonly operation: RmanOperation;
  readonly elapsedMs: number;
  readonly output:    ReadonlyArray<string>;
}

export interface JobError {
  readonly jobId:     string;
  readonly operation: RmanOperation;
  readonly error:     RmanError;
  readonly elapsedMs: number;
}
