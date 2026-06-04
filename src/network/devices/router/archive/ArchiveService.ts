export interface ArchivePath {
  path: string;
  timePeriodMin?: number;
  maximumVersions?: number;
  writeMemory?: boolean;
}

export interface ArchiveConfigLogger {
  enabled: boolean;
  logging: boolean;
  hidekeys: boolean;
  notifySyslogContent?: 'plaintext' | 'xml';
}

export interface ArchivedRevision {
  index: number;
  capturedAtMs: number;
  source: 'manual' | 'auto-time' | 'auto-write-memory';
  bytes: number;
  path: string;
}

export class ArchiveService {
  private archivePath: ArchivePath = { path: '' };
  private configLogger: ArchiveConfigLogger = { enabled: false, logging: false, hidekeys: false };
  private readonly revisions: ArchivedRevision[] = [];
  private revisionCounter = 0;

  setPath(path: string): void { this.archivePath.path = path; }
  setTimePeriod(min: number): void { this.archivePath.timePeriodMin = min; }
  setMaximum(n: number): void { this.archivePath.maximumVersions = n; }
  setWriteMemory(on: boolean): void { this.archivePath.writeMemory = on; }
  getPath(): Readonly<ArchivePath> { return this.archivePath; }

  enableLogging(): void { this.configLogger.enabled = true; this.configLogger.logging = true; }
  disableLogging(): void { this.configLogger.logging = false; }
  setHidekeys(on: boolean): void { this.configLogger.hidekeys = on; }
  setNotifySyslog(content: 'plaintext' | 'xml'): void {
    this.configLogger.notifySyslogContent = content;
  }
  setLogBufferSize(n: number): void { (this.configLogger as unknown as { bufferSize?: number }).bufferSize = n; }
  getConfigLogger(): Readonly<ArchiveConfigLogger> { return this.configLogger; }

  capture(source: ArchivedRevision['source'], bytes: number, path: string): ArchivedRevision {
    const rev: ArchivedRevision = {
      index: ++this.revisionCounter,
      capturedAtMs: Date.now(),
      source, bytes, path,
    };
    this.revisions.push(rev);
    while (this.archivePath.maximumVersions !== undefined
      && this.revisions.length > this.archivePath.maximumVersions) {
      this.revisions.shift();
    }
    return rev;
  }
  listRevisions(): readonly ArchivedRevision[] { return [...this.revisions]; }

  asRunningConfigLines(): string[] {
    if (!this.archivePath.path && !this.configLogger.enabled) return [];
    const lines = ['archive'];
    if (this.archivePath.path) lines.push(` path ${this.archivePath.path}`);
    if (this.archivePath.timePeriodMin !== undefined) lines.push(` time-period ${this.archivePath.timePeriodMin}`);
    if (this.archivePath.maximumVersions !== undefined) lines.push(` maximum ${this.archivePath.maximumVersions}`);
    if (this.archivePath.writeMemory) lines.push(' write-memory');
    if (this.configLogger.enabled) {
      lines.push(' log config');
      if (this.configLogger.logging) lines.push('  logging enable');
      if (this.configLogger.hidekeys) lines.push('  hidekeys');
      if (this.configLogger.notifySyslogContent) lines.push(`  notify syslog contenttype ${this.configLogger.notifySyslogContent}`);
    }
    return lines;
  }

  formatShowArchive(): string {
    if (this.revisions.length === 0) return 'No archives configured / no revisions captured.';
    const lines = [`The maximum archive configurations allowed is ${this.archivePath.maximumVersions ?? 14}.`];
    lines.push('No backups exist on archive path');
    if (this.archivePath.path) lines.push(`Archive path: ${this.archivePath.path}`);
    for (const r of this.revisions) {
      lines.push(`  ${r.index}: ${r.path} (${new Date(r.capturedAtMs).toISOString()}, ${r.bytes}B, src=${r.source})`);
    }
    return lines.join('\n');
  }

  formatShowArchiveDiff(): string {
    if (this.revisions.length < 2) return 'No archive differences available.';
    return `Differences between latest two archives (${this.revisions[this.revisions.length - 2].index} → ${this.revisions[this.revisions.length - 1].index})`;
  }
}
