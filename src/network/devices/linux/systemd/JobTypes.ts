import type { DependencyGraph } from '@/network/devices/linux/systemd/DependencyGraph';

export interface OperationResult {
  ok: boolean;
  error?: string;
  /** `error` is a complete systemctl message; the caller must not prefix it. */
  verbatim?: boolean;
}

export type JobType = 'start' | 'stop';

export interface Job {
  readonly unit: string;
  readonly type: JobType;
  readonly required: boolean;
}

export type JobOutcome = 'done' | 'failed' | 'skipped' | 'dependency-failed';

export interface JobResult {
  readonly unit: string;
  readonly outcome: JobOutcome;
  readonly error?: string;
  /** Carried from the activation hook so the message reaches the caller intact. */
  readonly verbatim?: boolean;
}

export interface JobEngineHooks {
  graph(): DependencyGraph;
  isActive(unit: string): boolean;
  exists(unit: string): boolean;
  activate(unit: string): OperationResult;
  deactivate(unit: string): OperationResult;
}
