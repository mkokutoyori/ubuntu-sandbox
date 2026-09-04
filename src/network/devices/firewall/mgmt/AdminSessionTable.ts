export type AdminSessionType = 'CLI' | 'WEB';

export type AdminTransport = 'ssh' | 'telnet' | 'web' | 'console';

export const ADMIN_TRANSPORT_PROTOCOL: Readonly<Record<AdminTransport, string>> = {
  ssh: 'sshv2',
  telnet: 'telnet',
  web: 'https',
  console: 'console',
};

export interface AdminEndpoint {
  readonly ip: string;
  readonly port: number;
}

export interface AdminSession {
  readonly index: number;
  readonly username: string;
  readonly type: AdminSessionType;
  readonly transport: AdminTransport;
  readonly from: string;
  readonly localInterface: string;
  readonly local: AdminEndpoint;
  readonly remote: AdminEndpoint;
  readonly vdom: string;
  readonly since: number;
}

export interface AdminSessionDraft {
  readonly username: string;
  readonly type: AdminSessionType;
  readonly transport: AdminTransport;
  readonly localInterface?: string;
  readonly local?: AdminEndpoint;
  readonly remote?: AdminEndpoint;
  readonly vdom?: string;
}

export interface AdminSessionTableDeps {
  readonly now?: () => number;
}

const NO_ENDPOINT: AdminEndpoint = Object.freeze({ ip: '0.0.0.0', port: 0 });

export class AdminSessionTable {
  private readonly sessions = new Map<number, AdminSession>();
  private nextIndex = 0;
  private readonly now: () => number;

  constructor(deps: AdminSessionTableDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
  }

  open(draft: AdminSessionDraft): AdminSession {
    const remote = draft.remote ?? NO_ENDPOINT;
    const session: AdminSession = {
      index: this.nextIndex++,
      username: draft.username,
      type: draft.type,
      transport: draft.transport,
      from: adminSessionOrigin(draft.transport, remote.ip),
      localInterface: draft.localInterface ?? '',
      local: draft.local ?? NO_ENDPOINT,
      remote,
      vdom: draft.vdom ?? 'root',
      since: this.now(),
    };
    this.sessions.set(session.index, session);
    return session;
  }

  list(): readonly AdminSession[] {
    return [...this.sessions.values()].sort((a, b) => a.index - b.index);
  }

  newest(): AdminSession | undefined {
    const held = this.list();
    return held[held.length - 1];
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

export function adminSessionOrigin(transport: AdminTransport, ip: string): string {
  return transport === 'web' || transport === 'console'
    ? ip : `${transport}(${ip})`;
}
