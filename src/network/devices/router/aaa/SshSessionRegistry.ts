import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { NetworkOsAccountEventEnvelope, SshAuthMethod } from './NetworkOsAccount';

export type VtySessionState = 'active' | 'idle' | 'closed';

export interface SshSessionRecord {
  readonly id: string;
  readonly line: string;
  readonly lineIndex: number;
  readonly user: string;
  readonly privilege: number;
  readonly fromIp: string;
  readonly fromHost: string | null;
  readonly authMethod: SshAuthMethod;
  readonly loginAt: number;
  readonly lastActivityAt: number;
  readonly closedAt: number | null;
  readonly closeReason: string | null;
  readonly state: VtySessionState;
  readonly idleSeconds: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly terminalType: string | null;
  readonly localPort: number;
  readonly peerPort: number;
}

export interface SshSessionRegistryOptions {
  deviceId: string;
  bus: IEventBus;
  maxLines?: number;
  historyLimit?: number;
  now?: () => number;
}

interface MutableSession {
  id: string;
  line: string;
  lineIndex: number;
  user: string;
  privilege: number;
  fromIp: string;
  fromHost: string | null;
  authMethod: SshAuthMethod;
  loginAt: number;
  lastActivityAt: number;
  closedAt: number | null;
  closeReason: string | null;
  bytesIn: number;
  bytesOut: number;
  terminalType: string | null;
  localPort: number;
  peerPort: number;
}

export class SshSessionRegistry {
  private readonly deviceId: string;
  private readonly bus: IEventBus;
  private readonly maxLines: number;
  private readonly historyLimit: number;
  private readonly now: () => number;
  private readonly subs: Unsubscribe[] = [];

  private readonly active: Map<string, MutableSession> = new Map();
  private readonly closed: MutableSession[] = [];
  private nextSessionSeq = 1;

  constructor(opts: SshSessionRegistryOptions) {
    this.deviceId = opts.deviceId;
    this.bus = opts.bus;
    this.maxLines = opts.maxLines ?? 16;
    this.historyLimit = opts.historyLimit ?? 256;
    this.now = opts.now ?? Date.now;
    this.subs.push(this.bus.subscribe('router.aaa.account.login.success', this.onLoginSuccess));
    this.subs.push(this.bus.subscribe('router.ssh.session.closed', this.onSessionClosed));
  }

  detach(): void { for (const s of this.subs) s(); this.subs.length = 0; }

  private snapshot(s: MutableSession, now: number): SshSessionRecord {
    return {
      id: s.id, line: s.line, lineIndex: s.lineIndex, user: s.user,
      privilege: s.privilege, fromIp: s.fromIp, fromHost: s.fromHost,
      authMethod: s.authMethod, loginAt: s.loginAt,
      lastActivityAt: s.lastActivityAt, closedAt: s.closedAt,
      closeReason: s.closeReason,
      state: s.closedAt ? 'closed' : (now - s.lastActivityAt > 300_000 ? 'idle' : 'active'),
      idleSeconds: Math.max(0, Math.floor(((s.closedAt ?? now) - s.lastActivityAt) / 1000)),
      bytesIn: s.bytesIn, bytesOut: s.bytesOut, terminalType: s.terminalType,
      localPort: s.localPort, peerPort: s.peerPort,
    };
  }

  list(now: number = this.now()): readonly SshSessionRecord[] {
    return Array.from(this.active.values())
      .sort((a, b) => a.lineIndex - b.lineIndex)
      .map(s => this.snapshot(s, now));
  }

  history(): readonly SshSessionRecord[] {
    const now = this.now();
    return this.closed.map(s => this.snapshot(s, now));
  }

  find(id: string): SshSessionRecord | null {
    const s = this.active.get(id);
    return s ? this.snapshot(s, this.now()) : null;
  }

  private allocateLine(): { line: string; index: number } | null {
    const taken = new Set(Array.from(this.active.values()).map(s => s.lineIndex));
    for (let i = 0; i < this.maxLines; i++) {
      if (!taken.has(i)) return { line: `vty ${i}`, index: i };
    }
    return null;
  }

  open(input: {
    user: string;
    privilege?: number;
    fromIp: string;
    fromHost?: string;
    authMethod?: SshAuthMethod;
    at?: number;
    terminalType?: string;
    localPort?: number;
    peerPort?: number;
  }): SshSessionRecord | null {
    const slot = this.allocateLine();
    if (!slot) return null;
    const at = input.at ?? this.now();
    const session: MutableSession = {
      id: `ssh-${this.nextSessionSeq++}`,
      line: slot.line,
      lineIndex: slot.index,
      user: input.user,
      privilege: input.privilege ?? 1,
      fromIp: input.fromIp,
      fromHost: input.fromHost ?? null,
      authMethod: input.authMethod ?? 'password',
      loginAt: at,
      lastActivityAt: at,
      closedAt: null,
      closeReason: null,
      bytesIn: 0,
      bytesOut: 0,
      terminalType: input.terminalType ?? null,
      localPort: input.localPort ?? 22,
      peerPort: input.peerPort ?? 0,
    };
    this.active.set(session.id, session);
    this.bus.publish({
      topic: 'router.ssh.session.opened',
      payload: { deviceId: this.deviceId, session: this.snapshot(session, at) },
    });
    return this.snapshot(session, at);
  }

  touch(id: string, at: number = this.now(), bytesIn = 0, bytesOut = 0): void {
    const s = this.active.get(id);
    if (!s) return;
    s.lastActivityAt = at;
    s.bytesIn += bytesIn;
    s.bytesOut += bytesOut;
  }

  close(id: string, reason: string = 'logout', at: number = this.now()): SshSessionRecord | null {
    const s = this.active.get(id);
    if (!s) return null;
    s.closedAt = at;
    s.closeReason = reason;
    this.active.delete(id);
    this.closed.push(s);
    while (this.closed.length > this.historyLimit) this.closed.shift();
    const snap = this.snapshot(s, at);
    this.bus.publish({
      topic: 'router.ssh.session.closed',
      payload: { deviceId: this.deviceId, session: snap, reason },
    });
    return snap;
  }

  closeWhere(predicate: (s: SshSessionRecord) => boolean, reason = 'admin'): number {
    let count = 0;
    for (const s of [...this.active.values()]) {
      if (predicate(this.snapshot(s, this.now()))) {
        this.close(s.id, reason);
        count++;
      }
    }
    return count;
  }

  private onLoginSuccess = (e: { topic: string; payload: unknown }) => {
    const env = e as unknown as NetworkOsAccountEventEnvelope;
    if (env.payload.deviceId !== this.deviceId) return;
    this.open({
      user: env.payload.account.name,
      privilege: env.payload.account.privilege,
      fromIp: env.payload.from ?? 'unknown',
      authMethod: env.payload.method ?? 'password',
      at: env.payload.at,
    });
  };

  private onSessionClosed = () => { /* placeholder for external close hook */ };

  formatShowUsers(now: number = this.now()): string {
    const header = '    Line       User       Host(s)              Idle       Location';
    if (this.active.size === 0) return `${header}\n*  0 con 0                idle                 00:00:00`;
    const rows: string[] = [header];
    let starred = false;
    for (const s of this.list(now)) {
      const idle = secondsToHms(s.idleSeconds);
      const marker = !starred ? '*' : ' ';
      starred = true;
      rows.push(`${marker} ${(s.lineIndex + 1).toString().padStart(3, ' ')} ${s.line.padEnd(7, ' ')}   ${s.user.padEnd(10, ' ')} idle                 ${idle} ${s.fromIp}`);
    }
    return rows.join('\n');
  }

  formatDisplayUsers(now: number = this.now()): string {
    const header = '  UI    Delay    Type     Network Address     AuthenStatus    AuthorcmdFlag   User';
    if (this.active.size === 0) return `${header}\n+ 0     00:00:00 CON 0                        pass            N`;
    const rows: string[] = [header];
    for (const s of this.list(now)) {
      const delay = secondsToHms(s.idleSeconds);
      rows.push(`+ ${(129 + s.lineIndex).toString().padEnd(5, ' ')} ${delay} SSH      ${s.fromIp.padEnd(20, ' ')} pass            N               ${s.user}`);
    }
    return rows.join('\n');
  }
}

function secondsToHms(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function pad(n: number): string { return n.toString().padStart(2, '0'); }
