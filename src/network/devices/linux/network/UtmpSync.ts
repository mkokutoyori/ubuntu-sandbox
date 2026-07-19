import type { VirtualFileSystem } from '../VirtualFileSystem';
import { encodeUtmpFile, encodeBtmpFile, decodeUtmpFile, decodeBtmpFile } from './UtmpBinaryFormat';

export interface UtmpRecord {
  user: string;
  tty: string;
  fromIp: string;
  fromHost?: string;
  loginAt: number;
  closedAt?: number | null;
  shellPid?: number;
  sshdPid?: number;
  uid?: number;
}

export interface BtmpRecord {
  user: string;
  tty: string;
  fromIp: string;
  at: number;
}

const UTMP_PATH = '/var/run/utmp';
const WTMP_PATH = '/var/log/wtmp';
const BTMP_PATH = '/var/log/btmp';

export class UtmpSync {
  constructor(private readonly vfs: VirtualFileSystem) {}

  bootstrap(): void {
    this.ensure(UTMP_PATH, 0o644);
    this.ensure(WTMP_PATH, 0o644);
    // btmp holds failed-login usernames/sources — real Linux keeps it
    // 0600 root:root (lastb itself requires root), unlike wtmp's 0644.
    this.ensure(BTMP_PATH, 0o600);
  }

  appendRebootMark(at: Date): void {
    const arr = this.readWtmp();
    arr.push({ user: 'reboot', tty: 'system boot', fromIp: '', loginAt: at.getTime() });
    this.writeRaw(WTMP_PATH, arr);
  }

  openSession(rec: UtmpRecord): void {
    const utmp = this.readUtmp();
    utmp.push(rec);
    this.writeRaw(UTMP_PATH, utmp);
    const wtmp = this.readWtmp();
    wtmp.push(rec);
    this.writeRaw(WTMP_PATH, wtmp);
  }

  updateSessionPids(tty: string, shellPid: number, sshdPid?: number): void {
    const patch = (r: UtmpRecord): UtmpRecord =>
      (r.tty === tty && !r.closedAt && r.user !== 'reboot')
        ? { ...r, shellPid, sshdPid: sshdPid ?? r.sshdPid }
        : r;
    this.writeRaw(UTMP_PATH, this.readUtmp().map(patch));
    this.writeRaw(WTMP_PATH, this.readWtmp().map(patch));
  }

  closeSession(tty: string, closedAt: Date): void {
    const utmp = this.readUtmp().filter((r) => r.tty !== tty);
    this.writeRaw(UTMP_PATH, utmp);
    const wtmp = this.readWtmp().map((r) => {
      if (r.tty === tty && !r.closedAt && r.user !== 'reboot') {
        return { ...r, closedAt: closedAt.getTime() };
      }
      return r;
    });
    this.writeRaw(WTMP_PATH, wtmp);
  }

  appendFailure(rec: BtmpRecord): void {
    const btmp = this.readBtmp();
    btmp.push(rec);
    this.vfs.writeFile(BTMP_PATH, encodeBtmpFile(btmp), 0, 0, 0o022, false);
  }

  readUtmp(): UtmpRecord[] { return this.readArray(UTMP_PATH); }
  readWtmp(): UtmpRecord[] { return this.readArray(WTMP_PATH); }
  readBtmp(): BtmpRecord[] {
    const raw = this.vfs.readFile(BTMP_PATH);
    if (!raw) return [];
    return decodeBtmpFile(raw);
  }

  private readArray(path: string): UtmpRecord[] {
    const raw = this.vfs.readFile(path);
    if (!raw) return [];
    return decodeUtmpFile(raw);
  }

  private writeRaw(path: string, arr: UtmpRecord[]): void {
    this.vfs.writeFile(path, encodeUtmpFile(arr), 0, 0, 0o022, false);
  }

  private ensure(path: string, mode: number): void {
    if (!this.vfs.exists(path)) {
      this.vfs.writeFile(path, '', 0, 0, 0o022, false);
      this.vfs.chmod(path, mode);
    }
  }
}
