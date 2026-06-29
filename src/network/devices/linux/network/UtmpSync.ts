import type { VirtualFileSystem } from '../VirtualFileSystem';

export interface UtmpRecord {
  user: string;
  tty: string;
  fromIp: string;
  fromHost?: string;
  loginAt: number;
  closedAt?: number | null;
  shellPid?: number;
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
    this.ensure(UTMP_PATH);
    this.ensure(WTMP_PATH);
    this.ensure(BTMP_PATH);
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
    this.writeRaw(BTMP_PATH, btmp);
  }

  readUtmp(): UtmpRecord[] { return this.readArray(UTMP_PATH); }
  readWtmp(): UtmpRecord[] { return this.readArray(WTMP_PATH); }
  readBtmp(): BtmpRecord[] {
    const raw = this.vfs.readFile(BTMP_PATH);
    if (!raw || raw.trim().length === 0) return [];
    try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }

  private readArray(path: string): UtmpRecord[] {
    const raw = this.vfs.readFile(path);
    if (!raw || raw.trim().length === 0) return [];
    try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }

  private writeRaw(path: string, arr: unknown): void {
    this.vfs.writeFile(path, JSON.stringify(arr), 0, 0, 0o022, false);
  }

  private ensure(path: string): void {
    if (!this.vfs.exists(path)) {
      this.vfs.writeFile(path, '[]', 0, 0, 0o022, false);
    }
  }
}
