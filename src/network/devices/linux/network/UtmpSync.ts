import { IPAddress, IPv6Address } from '@/network/core/types';
import type { VirtualFileSystem } from '../VirtualFileSystem';
import { UT, UTMPX_SIZE, Utmpx, binaryStringToBytes, bytesToBinaryString } from '../login/UtmpxRecord';

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
  pid?: number;
}

const UTMP_PATH = '/var/run/utmp';
const WTMP_PATH = '/var/log/wtmp';
const BTMP_PATH = '/var/log/btmp';
const BOOT_ID = '~~';
const UTMP_GID = 43;
const RUNLEVEL_MULTIUSER = ('N'.charCodeAt(0) << 8) | '5'.charCodeAt(0);

function idOf(line: string): string {
  return line.length > 4 ? line.slice(line.length - 4) : line;
}

function addressBytes(text: string): Uint8Array {
  const out = new Uint8Array(16);
  const v4 = IPAddress.tryParse(text);
  if (v4) {
    out.set(v4.getOctets(), 0);
    return out;
  }
  const v6 = IPv6Address.tryParse(text);
  if (v6) {
    const view = new DataView(out.buffer);
    v6.getHextets().forEach((hextet, index) => view.setUint16(index * 2, hextet, false));
  }
  return out;
}

function addressText(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
  if (view.getUint32(4, true) === 0 && view.getUint32(8, true) === 0 && view.getUint32(12, true) === 0) {
    if (view.getUint32(0, true) === 0) return '';
    return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
  }
  return new IPv6Address(Array.from({ length: 8 }, (_, index) => view.getUint16(index * 2, false))).toString();
}

export class UtmpSync {
  private uidOf: (user: string) => number | undefined = () => undefined;
  private kernelRelease: () => string = () => '';

  constructor(private readonly vfs: VirtualFileSystem) {}

  bindUidResolver(resolver: (user: string) => number | undefined): void {
    this.uidOf = resolver;
  }

  bindKernelRelease(provider: () => string): void {
    this.kernelRelease = provider;
  }

  bootstrap(): void {
    this.ensure(UTMP_PATH, 0o644);
    this.ensure(WTMP_PATH, 0o664);
    this.ensure(BTMP_PATH, 0o660);
  }

  appendRebootMark(at: Date): void {
    const boot = new Utmpx();
    boot.type = UT.BOOT_TIME;
    boot.setField('line', '~');
    boot.setField('id', BOOT_ID);
    boot.setField('user', 'reboot');
    boot.setField('host', this.kernelRelease());
    this.stamp(boot, at.getTime());
    const level = new Utmpx();
    level.type = UT.RUN_LVL;
    level.pid = RUNLEVEL_MULTIUSER;
    level.setField('line', '~');
    level.setField('id', BOOT_ID);
    level.setField('user', 'runlevel');
    level.setField('host', this.kernelRelease());
    this.stamp(level, at.getTime());
    this.appendTo(WTMP_PATH, [boot, level]);
  }

  appendShutdown(at: Date): void {
    const entry = new Utmpx();
    entry.type = UT.RUN_LVL;
    entry.setField('line', '~');
    entry.setField('id', BOOT_ID);
    entry.setField('user', 'shutdown');
    entry.setField('host', this.kernelRelease());
    this.stamp(entry, at.getTime());
    this.appendTo(WTMP_PATH, [entry]);
  }

  openSession(rec: UtmpRecord): void {
    const entry = new Utmpx();
    entry.type = UT.USER_PROCESS;
    entry.pid = rec.sshdPid ?? rec.shellPid ?? 0;
    entry.setField('line', rec.tty);
    entry.setField('id', idOf(rec.tty));
    entry.setField('user', rec.user);
    entry.setField('host', rec.fromIp || rec.fromHost || '');
    entry.setAddress(addressBytes(rec.fromIp));
    this.stamp(entry, rec.loginAt);
    this.upsertLive(entry);
    this.appendTo(WTMP_PATH, [entry]);
  }

  updateSessionPids(tty: string, shellPid: number, sshdPid?: number): void {
    const records = this.readFile(UTMP_PATH);
    let changed = false;
    for (const entry of records) {
      if (entry.type === UT.USER_PROCESS && entry.text('line') === tty) {
        entry.pid = sshdPid ?? shellPid;
        changed = true;
      }
    }
    if (changed) this.writeFile(UTMP_PATH, records);
    const history = this.readFile(WTMP_PATH);
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].type === UT.USER_PROCESS && history[i].text('line') === tty) {
        history[i].pid = sshdPid ?? shellPid;
        this.writeFile(WTMP_PATH, history);
        break;
      }
    }
  }

  closeSession(tty: string, closedAt: Date): void {
    const records = this.readFile(UTMP_PATH);
    const live = records.find((entry) => entry.type === UT.USER_PROCESS && entry.text('line') === tty);
    if (!live) return;
    const dead = new Utmpx();
    dead.type = UT.DEAD_PROCESS;
    dead.pid = live.pid;
    dead.setLineBytes(live.field('line'));
    dead.setField('id', live.text('id'));
    this.stamp(dead, closedAt.getTime());
    live.type = UT.DEAD_PROCESS;
    live.setField('user', '');
    live.setField('host', '');
    live.setAddress(new Uint8Array(16));
    this.stamp(live, closedAt.getTime());
    this.writeFile(UTMP_PATH, records);
    this.appendTo(WTMP_PATH, [dead]);
  }

  appendFailure(rec: BtmpRecord): void {
    const entry = new Utmpx();
    entry.type = UT.LOGIN_PROCESS;
    entry.pid = rec.pid ?? 0;
    entry.setField('line', rec.tty);
    entry.setField('user', rec.user);
    entry.setField('host', rec.fromIp);
    entry.setAddress(addressBytes(rec.fromIp));
    this.stamp(entry, rec.at);
    this.appendTo(BTMP_PATH, [entry]);
  }

  readUtmp(): UtmpRecord[] {
    return this.readFile(UTMP_PATH)
      .filter((entry) => entry.type === UT.USER_PROCESS)
      .map((entry) => {
        const user = entry.text('user');
        const host = entry.text('host');
        const fromIp = addressText(entry.address) || host;
        return {
          user,
          tty: entry.text('line'),
          fromIp,
          fromHost: host,
          loginAt: entry.seconds * 1000 + Math.floor(entry.microseconds / 1000),
          shellPid: entry.pid || undefined,
          uid: this.uidOf(user),
        };
      });
  }

  private stamp(entry: Utmpx, epochMs: number): void {
    entry.seconds = Math.floor(epochMs / 1000);
    entry.microseconds = Math.floor((epochMs % 1000) * 1000);
  }

  private upsertLive(entry: Utmpx): void {
    const records = this.readFile(UTMP_PATH);
    const line = entry.text('line');
    const slot = records.findIndex((existing) => existing.text('line') === line && existing.type !== UT.USER_PROCESS);
    if (slot >= 0) records[slot] = new Utmpx(entry.bytes);
    else {
      const duplicate = records.findIndex((existing) => existing.type === UT.USER_PROCESS && existing.text('line') === line);
      if (duplicate >= 0) records[duplicate] = new Utmpx(entry.bytes);
      else records.push(new Utmpx(entry.bytes));
    }
    this.writeFile(UTMP_PATH, records);
  }

  private readFile(path: string): Utmpx[] {
    const raw = this.vfs.readFile(path);
    if (!raw) return [];
    const bytes = binaryStringToBytes(raw);
    const out: Utmpx[] = [];
    for (let at = 0; at + UTMPX_SIZE <= bytes.length; at += UTMPX_SIZE) out.push(new Utmpx(bytes.subarray(at, at + UTMPX_SIZE)));
    return out;
  }

  private writeFile(path: string, records: Utmpx[]): void {
    this.vfs.writeFile(path, bytesToBinaryString(Uint8Array.from(records.flatMap((entry) => Array.from(entry.bytes)))), 0, 0, 0o022, false);
  }

  private appendTo(path: string, records: Utmpx[]): void {
    this.vfs.writeFile(path, bytesToBinaryString(Uint8Array.from(records.flatMap((entry) => Array.from(entry.bytes)))), 0, 0, 0o022, true);
  }

  private ensure(path: string, mode: number): void {
    if (!this.vfs.exists(path)) {
      this.vfs.writeFile(path, '', 0, 0, 0o022, false);
      this.vfs.chmod(path, mode);
      this.vfs.chown(path, 0, UTMP_GID);
    }
  }
}
