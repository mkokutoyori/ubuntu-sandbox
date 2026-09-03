export const BATCH_ENTERED = 'Enter batch mode...';
export const BATCH_EXITED = 'Exit and run batch commands...';
export const BATCH_STATUS_RUNNING = 'Batch mode is running.';
export const BATCH_STATUS_STOPPED = 'Batch mode is stopped.';

export interface BatchLogEntry {
  readonly returnCode: number;
  readonly command: string;
}

const RETURN_CODE = /Return code (-?\d+)/;

export function returnCodeOf(output: string): number {
  const found = RETURN_CODE.exec(output);
  return found === null ? 0 : Number.parseInt(found[1], 10);
}

export class BatchMode {
  private queued: string[] | null = null;
  private log: BatchLogEntry[] = [];

  running(): boolean { return this.queued !== null; }

  start(): void { this.queued = []; }

  queue(line: string): void { this.queued?.push(line); }

  pending(): readonly string[] { return this.queued ?? []; }

  end(run: (line: string) => string): boolean {
    const lines = this.queued;
    if (lines === null) return false;
    this.queued = null;
    this.log = lines.map(
      command => ({ returnCode: returnCodeOf(run(command)), command }));
    return true;
  }

  lastLog(): readonly BatchLogEntry[] { return this.log; }
}

export function renderBatchLog(entries: readonly BatchLogEntry[]): string {
  return entries.map(entry => `${entry.returnCode}: ${entry.command}`).join('\n');
}
