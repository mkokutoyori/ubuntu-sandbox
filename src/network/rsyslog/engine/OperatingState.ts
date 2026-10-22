import type { FileHandle, RsyslogFiles } from './Host';
import type { SyslogTime } from '@/network/syslog/codec/SyslogTime';

const INITIALIZING = 'INITIALIZING';
const CLEAN_CLOSE = 'CLEAN CLOSE';

export interface OperatingStateServices {
  readonly files: RsyslogFiles;
  readonly now: () => SyslogTime;
  readonly version: string;
  readonly report: (text: string, level: 'error' | 'info', code: number) => void;
}

export class OperatingStateFile {
  private handle: FileHandle | null = null;

  constructor(private readonly path: string, private readonly services: OperatingStateServices) {}

  open(): void {
    this.checkPrevious();
    const opened = this.services.files.open(this.path, {
      mode: 0o660, directoryMode: 0o700, uid: null, gid: null, directoryUid: null, directoryGid: null, createDirectories: false, failOnChownFailure: false,
    });
    if ('error' in opened) {
      this.services.report(`error opening operatingStateFile '${this.path}' for write - ignoring it: ${opened.error}`, 'error', -3000);
      return;
    }
    this.handle = opened.handle;
    this.write('STATE', `${INITIALIZING} ${this.services.version}`);
  }

  private checkPrevious(): void {
    const files = this.services.files;
    const content = files.read(this.path);
    if (content === null) return;
    const tail = content.length >= CLEAN_CLOSE.length + 1 ? content.slice(-(CLEAN_CLOSE.length + 1), -1) : null;
    if (tail === CLEAN_CLOSE) return;
    if (tail === null) {
      this.services.report(`error seeking to end of existing operatingStateFile '${this.path}' - this may be an indication of a problem, e.g. empty file`, 'error', -2027);
      return;
    }
    this.services.report(
      `existing operatingStateFile '${this.path}' does not end with '${CLEAN_CLOSE}, instead it has '${tail}' - this probably indicates an improper shutdown`,
      'error', -2027,
    );
    const previous = `${this.path}.previous`;
    if (files.write(previous, content) && files.write(this.path, '')) {
      this.services.report(`existing state file '${this.path}' renamed to '${previous}' - you may want to review it`, 'info', 0);
    }
  }

  write(tag: string, line: string): void {
    if (this.handle === null) return;
    const t = this.services.now();
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    const stamp = `${pad(t.year, 4)}${pad(t.month)}${pad(t.day)}-${pad(t.hour)}${pad(t.minute)}${pad(t.second)}`;
    this.handle.write(`${stamp}: ${tag.slice(0, 5).padEnd(5)} ${line}\n`.slice(0, 1023));
  }

  close(): void {
    if (this.handle === null) return;
    this.write('STATE', CLEAN_CLOSE);
    this.handle.close();
    this.handle = null;
  }
}
