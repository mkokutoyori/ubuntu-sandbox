export type AdminSessionType = 'CLI' | 'WEB';

export interface AdminSession {
  readonly index: number;
  readonly username: string;
  readonly type: AdminSessionType;
  readonly from: string;
  readonly since: number;
}

export interface AdminSessionTableDeps {
  readonly now?: () => number;
}

export class AdminSessionTable {
  private readonly sessions = new Map<number, AdminSession>();
  private nextIndex = 0;
  private readonly now: () => number;

  constructor(deps: AdminSessionTableDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
  }

  open(username: string, type: AdminSessionType, from: string): AdminSession {
    const session: AdminSession = {
      index: this.nextIndex++, username, type, from, since: this.now(),
    };
    this.sessions.set(session.index, session);
    return session;
  }

  list(): readonly AdminSession[] {
    return [...this.sessions.values()].sort((a, b) => a.index - b.index);
  }

  byIndex(index: number): AdminSession | undefined {
    return this.sessions.get(index);
  }

  close(index: number): AdminSession | undefined {
    const session = this.sessions.get(index);
    if (session) this.sessions.delete(index);
    return session;
  }

  closeNewestOf(username: string): AdminSession | undefined {
    const held = this.list().filter(s => s.username === username);
    const last = held[held.length - 1];
    if (last) this.sessions.delete(last.index);
    return last;
  }
}

export function adminSessionOrigin(transport: 'ssh' | 'telnet' | 'web', ip: string): string {
  return transport === 'web' ? ip : `${transport}(${ip})`;
}
