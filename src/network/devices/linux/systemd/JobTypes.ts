import type { DependencyGraph } from '@/network/devices/linux/systemd/DependencyGraph';

export interface OperationResult {
  ok: boolean;
  error?: string;
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
}

export interface JobEngineHooks {
  graph(): DependencyGraph;
  isActive(unit: string): boolean;
  exists(unit: string): boolean;
  activate(unit: string): OperationResult;
  deactivate(unit: string): OperationResult;
}
