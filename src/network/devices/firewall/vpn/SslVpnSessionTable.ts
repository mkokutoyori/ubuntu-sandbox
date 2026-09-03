export type SslVpnSessionMode = 'web' | 'tunnel';

export interface SslVpnSession {
  readonly index: number;
  readonly user: string;
  readonly group: string;
  readonly sourceIp: string;
  readonly mode: SslVpnSessionMode;
  readonly authType: string;
  readonly openedAt: number;
  readonly tunnelIp: string;
}

export interface SslVpnSessionRequest {
  readonly user: string;
  readonly group?: string;
  readonly sourceIp: string;
  readonly mode: SslVpnSessionMode;
  readonly authType?: string;
  readonly tunnelIp?: string;
}

export const SSL_VPN_DEFAULT_IDLE_TIMEOUT = 300;

export class SslVpnSessionTable {
  private readonly sessions = new Map<number, SslVpnSession>();
  private nextIndex = 0;
  private idleTimeout = SSL_VPN_DEFAULT_IDLE_TIMEOUT;

  constructor(private readonly now: () => number = () => Date.now()) {}

  setIdleTimeout(seconds: number): void { this.idleTimeout = seconds; }

  getIdleTimeout(): number { return this.idleTimeout; }

  open(request: SslVpnSessionRequest): SslVpnSession {
    const session: SslVpnSession = {
      index: this.nextIndex++,
      user: request.user,
      group: request.group ?? '',
      sourceIp: request.sourceIp,
      mode: request.mode,
      authType: request.authType ?? '1(1)',
      openedAt: this.now(),
      tunnelIp: request.tunnelIp ?? '',
    };
    this.sessions.set(session.index, session);
    return session;
  }

  remaining(session: SslVpnSession): number {
    if (this.idleTimeout <= 0) return 0;
    const elapsed = Math.floor((this.now() - session.openedAt) / 1000);
    return Math.max(0, this.idleTimeout - elapsed);
  }

  durationOf(session: SslVpnSession): number {
    return Math.max(0, Math.floor((this.now() - session.openedAt) / 1000));
  }

  private prune(): void {
    if (this.idleTimeout <= 0) return;
    for (const [index, session] of [...this.sessions]) {
      if (this.remaining(session) === 0) this.sessions.delete(index);
    }
  }

  list(mode?: SslVpnSessionMode): readonly SslVpnSession[] {
    this.prune();
    const all = [...this.sessions.values()].sort((a, b) => a.index - b.index);
    return mode === undefined ? all : all.filter(session => session.mode === mode);
  }

  byIndex(index: number): SslVpnSession | undefined {
    this.prune();
    return this.sessions.get(index);
  }

  close(index: number): boolean { return this.sessions.delete(index); }

  closeAll(mode?: SslVpnSessionMode): number {
    const doomed = this.list(mode);
    for (const session of doomed) this.sessions.delete(session.index);
    return doomed.length;
  }
}
