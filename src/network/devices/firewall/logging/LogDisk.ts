export type LogFilePrefix = 'tlog' | 'elog';

export interface RolledLogFile {
  readonly prefix: LogFilePrefix;
  readonly bytes: number;
  readonly at: number;
}

export interface LogDiskFile {
  readonly name: string;
  readonly bytes: number;
  readonly at: number;
}

export class LogDisk {
  private rolled = new Map<LogFilePrefix, RolledLogFile[]>();

  roll(prefix: LogFilePrefix, bytes: number, at: number): void {
    if (bytes <= 0) return;
    const existing = this.rolled.get(prefix) ?? [];
    this.rolled.set(prefix, [{ prefix, bytes, at }, ...existing]);
  }

  listing(prefix: LogFilePrefix, current?: RolledLogFile): readonly LogDiskFile[] {
    const files: LogDiskFile[] = [];
    if (current !== undefined && current.bytes > 0) {
      files.push({ name: prefix, bytes: current.bytes, at: current.at });
    }
    const older = this.rolled.get(prefix) ?? [];
    older.forEach((file, index) => {
      files.push({ name: `${prefix}.${index + 1}`, bytes: file.bytes, at: file.at });
    });
    return Object.freeze(files);
  }

  rolledCount(prefix: LogFilePrefix): number {
    return (this.rolled.get(prefix) ?? []).length;
  }

  format(): void {
    this.rolled.clear();
  }
}
