import { simulationNowMs } from '@/network/core/SystemClock';

import type { VirtualFileSystem } from './VirtualFileSystem';
import { binaryStringToBytes, bytesToBinaryString } from '@/crypto/encoding';
import { LASTLOG_RECORD_SIZE } from './login/LastlogTool';

export const LASTLOG_PATH = '/var/log/lastlog';
const LOG_DIR = '/var/log';
const UTMP_GID = 43;
const LINE_SIZE = 32;
const HOST_SIZE = 256;

export interface LastlogEntry {
  readonly when: number;
  readonly sourceHost: string;
  readonly tty: string;
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

export class LinuxLastlogRegistry {
  private readonly previous = new Map<string, LastlogEntry>();
  private vfs: VirtualFileSystem | null = null;
  private uidOf: (user: string) => number | undefined = () => undefined;

  bindUidResolver(resolver: (user: string) => number | undefined): void {
    this.uidOf = resolver;
  }

  attachVfs(vfs: VirtualFileSystem): void {
    this.vfs = vfs;
    if (!vfs.exists(LOG_DIR)) vfs.mkdirp(LOG_DIR, 0o755, 0, 0);
    if (!vfs.exists(LASTLOG_PATH)) {
      vfs.writeFile(LASTLOG_PATH, '', 0, 0, 0o022);
      vfs.chmod(LASTLOG_PATH, 0o664);
      vfs.chown(LASTLOG_PATH, 0, UTMP_GID);
    }
  }

  record(user: string, sourceHost: string, tty: string, when: number = simulationNowMs()): LastlogEntry | undefined {
    const uid = this.uidOf(user);
    if (this.vfs === null || uid === undefined) return undefined;
    const before = this.read(uid);
    if (before) this.previous.set(user, before);
    const record = new Uint8Array(LASTLOG_RECORD_SIZE);
    const view = new DataView(record.buffer);
    view.setInt32(0, Math.floor(when / 1000), true);
    record.set(new TextEncoder().encode(tty).subarray(0, LINE_SIZE), 4);
    record.set(new TextEncoder().encode(sourceHost).subarray(0, HOST_SIZE), 4 + LINE_SIZE);
    this.splice(uid, bytesToBinaryString(record));
    return before;
  }

  getPrevious(user: string): LastlogEntry | undefined {
    return this.previous.get(user);
  }

  getCurrent(user: string): LastlogEntry | undefined {
    const uid = this.uidOf(user);
    return uid === undefined ? undefined : this.read(uid);
  }

  reset(): void {
    this.previous.clear();
    this.store(new Uint8Array(0));
  }

  clearUser(user: string): void {
    const uid = this.uidOf(user);
    if (uid === undefined) return;
    if ((this.vfs?.readFile(LASTLOG_PATH) ?? '').length < (uid + 1) * LASTLOG_RECORD_SIZE) return;
    this.splice(uid, '\0'.repeat(LASTLOG_RECORD_SIZE));
  }

  filePath(): string {
    return LASTLOG_PATH;
  }

  private splice(uid: number, record: string): void {
    const content = this.vfs?.readFile(LASTLOG_PATH) ?? '';
    const offset = uid * LASTLOG_RECORD_SIZE;
    const head = content.length >= offset ? content.slice(0, offset) : content + '\0'.repeat(offset - content.length);
    this.vfs?.writeFile(LASTLOG_PATH, head + record + content.slice(offset + LASTLOG_RECORD_SIZE), 0, 0, 0o022);
  }

  private store(bytes: Uint8Array): void {
    this.vfs?.writeFile(LASTLOG_PATH, bytesToBinaryString(bytes), 0, 0, 0o022);
  }

  private read(uid: number): LastlogEntry | undefined {
    const content = this.vfs?.readFile(LASTLOG_PATH) ?? '';
    const offset = uid * LASTLOG_RECORD_SIZE;
    if (offset + LASTLOG_RECORD_SIZE > content.length) return undefined;
    const record = binaryStringToBytes(content.slice(offset, offset + LASTLOG_RECORD_SIZE));
    const seconds = new DataView(record.buffer, record.byteOffset, record.byteLength).getInt32(0, true);
    if (seconds === 0) return undefined;
    return {
      when: seconds * 1000,
      tty: cString(record.subarray(4, 4 + LINE_SIZE)),
      sourceHost: cString(record.subarray(4 + LINE_SIZE, 4 + LINE_SIZE + HOST_SIZE)),
    };
  }

  static format(entry: LastlogEntry): string {
    const d = new Date(entry.when);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n: number): string => String(n).padStart(2, '0');
    const ctime = `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
    return `Last login: ${ctime} from ${entry.sourceHost}`;
  }
}
