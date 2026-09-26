import type { CaptureFrame } from './CaptureFrame';
import { serializeCaptureFile, type CaptureFileHeader } from './CaptureFileFormat';

const PCAP_FILE_HEADER_BYTES = 24;
const PCAP_RECORD_HEADER_BYTES = 16;
const MEGABYTE = 1_000_000;

export interface RotationPolicy {
  sizeLimitMegabytes: number | null;
  rotateSeconds: number | null;
  fileCount: number | null;
}

export type WriteOutcome = 'written' | 'limit-reached' | 'write-failed';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function dayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1);
  return Math.floor((date.getTime() - start.getTime()) / 86_400_000) + 1;
}

export function strftime(template: string, date: Date): string {
  return template.replace(/%([YmdHMSsjabyeF%])/g, (_, code: string) => {
    switch (code) {
      case 'Y': return String(date.getFullYear());
      case 'y': return two(date.getFullYear() % 100);
      case 'm': return two(date.getMonth() + 1);
      case 'd': return two(date.getDate());
      case 'e': return String(date.getDate()).padStart(2, ' ');
      case 'H': return two(date.getHours());
      case 'M': return two(date.getMinutes());
      case 'S': return two(date.getSeconds());
      case 's': return String(Math.floor(date.getTime() / 1000));
      case 'j': return String(dayOfYear(date)).padStart(3, '0');
      case 'a': return WEEKDAYS[date.getDay()];
      case 'b': return MONTHS[date.getMonth()];
      case 'F': return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
      default: return '%';
    }
  });
}

function suffixWidth(fileCount: number | null): number {
  if (fileCount === null) return 0;
  let remaining = fileCount - 1;
  let digits = 0;
  while (remaining > 0) {
    digits++;
    remaining = Math.floor(remaining / 10);
  }
  return digits;
}

export class CaptureFileWriter {
  private frames: CaptureFrame[] = [];
  private currentName: string;
  private sizeBytes = PCAP_FILE_HEADER_BYTES;
  private sizeCount = 0;
  private timeCount = 0;
  private openedAt: Date;
  private readonly width: number;

  constructor(
    private readonly template: string,
    private readonly policy: RotationPolicy,
    private readonly header: CaptureFileHeader,
    private readonly write: (path: string, content: string) => boolean,
    private readonly now: () => Date,
  ) {
    this.width = suffixWidth(policy.fileCount);
    this.openedAt = now();
    this.currentName = this.nameFor(0, this.policy.sizeLimitMegabytes !== null ? this.width : 0);
  }

  get fileName(): string {
    return this.currentName;
  }

  open(): boolean {
    return this.flush();
  }

  add(frame: CaptureFrame): WriteOutcome {
    const rotation = this.rotateIfDue();
    if (rotation !== 'written') return rotation;
    this.frames.push(frame);
    this.sizeBytes += PCAP_RECORD_HEADER_BYTES + Math.min(frame.length, this.header.snaplen);
    return this.flush() ? 'written' : 'write-failed';
  }

  private rotateIfDue(): WriteOutcome {
    const seconds = this.policy.rotateSeconds;
    if (seconds !== null && seconds > 0) {
      const at = this.now();
      if ((at.getTime() - this.openedAt.getTime()) / 1000 >= seconds) {
        this.openedAt = at;
        this.timeCount++;
        if (this.policy.sizeLimitMegabytes === null && this.policy.fileCount !== null
          && this.timeCount >= this.policy.fileCount) {
          return 'limit-reached';
        }
        this.sizeCount = 0;
        return this.startFile(this.nameFor(0, 0));
      }
    }
    const limit = this.policy.sizeLimitMegabytes;
    if (limit !== null && this.sizeBytes > limit * MEGABYTE) {
      this.sizeCount++;
      if (this.policy.fileCount !== null && this.sizeCount >= this.policy.fileCount) this.sizeCount = 0;
      return this.startFile(this.nameFor(this.sizeCount, this.width));
    }
    return 'written';
  }

  private startFile(name: string): WriteOutcome {
    this.currentName = name;
    this.frames = [];
    this.sizeBytes = PCAP_FILE_HEADER_BYTES;
    return this.flush() ? 'written' : 'write-failed';
  }

  private nameFor(count: number, width: number): string {
    const base = this.policy.rotateSeconds !== null && this.policy.rotateSeconds > 0
      ? strftime(this.template, this.openedAt)
      : this.template;
    if (count === 0 && width === 0) return base;
    return `${base}${String(count).padStart(width, '0')}`;
  }

  private flush(): boolean {
    return this.write(this.currentName, serializeCaptureFile(this.frames, this.header));
  }
}
