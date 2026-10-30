import type { BrokenDownTime } from '../../../logrotate/CalendarTime';
import type { ProcessTask } from '../../../process/ProcessTask';

export interface PsTerminal {
  readonly isTerminal: boolean;
  readonly columns: number;
  readonly rows: number;
}

export interface PsTtyLookup {
  readonly isCharacterDevice: boolean;
  readonly device: number;
}

export interface PsHost {
  readonly selfPid: number;
  readonly hertz: number;
  readonly pageSizeBytes: number;
  readonly memoryTotalKb: number;
  readonly pidDigits: number;
  readonly bootTimeSeconds: number;
  readonly uptimeSeconds: number;
  readonly nowSeconds: number;
  readonly effectiveUid: number;
  readonly controllingTty: number;
  readonly terminal: PsTerminal;
  readonly utf8: boolean;
  environment(name: string): string | undefined;
  collate(left: string, right: string): number;
  tasks(includeThreads: boolean): readonly ProcessTask[];
  selected(pids: readonly number[], includeThreads: boolean): readonly ProcessTask[];
  userId(name: string): number | null;
  groupId(name: string): number | null;
  statTty(path: string): PsTtyLookup | null;
  localTime(epochSeconds: number): BrokenDownTime;
  formatTime(format: string, epochSeconds: number): string;
}
