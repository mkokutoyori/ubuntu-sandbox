/**
 * IRmanJobEngine — interface implemented by RmanJobEngine.
 */

import type { Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { RmanJob } from './types';

export interface IRmanJobEngine {
  /**
   * Execute a job. The result is `ok(undefined)` even on failure — the
   * concrete error is published on the bus via JOB_FAILED. The Result
   * is only used for synchronous fatal pre-conditions.
   */
  run(job: RmanJob): Result<void, RmanError>;
  /** Cancel an in-flight job; emits JOB_CANCELLED if the job is still active. */
  cancel(jobId: string): void;
}
