import type {
  ITelnetServerContext,
  TelnetAdmission,
  TelnetAuthPrompt,
  TelnetSessionHandle,
  TelnetVtyShell,
} from './ITelnetServerContext';

export const LOGIN_MAX_TRIES = 3;

export interface LinuxTelnetAccount {
  readonly uid: number;
  readonly home: string;
  readonly shell: string;
}

export interface LinuxTelnetHost {
  hostname(): string;
  readFile(path: string): string | null;
  telnetActive(): boolean;
  account(user: string): LinuxTelnetAccount | null;
  authenticate(user: string, password: string): boolean;
  runLine(user: string, line: string): Promise<string>;
  openSession(user: string, fromIp: string, peerPort: number): TelnetSessionHandle | null;
  closeSession(id: string, reason: string): void;
  recordLogin(user: string, fromIp: string, tty: string, uid: number): void;
  recordAuthFailure(user: string | null, fromIp: string, attempt: number, reason: string): void;
}

export class LinuxTelnetServerContext implements ITelnetServerContext {
  private attempts = 0;
  private sourceIp = '';

  constructor(private readonly host: LinuxTelnetHost) {}

  hostname(): string {
    return this.host.hostname();
  }

  banner(): string | null {
    const issue = this.host.readFile('/etc/issue.net');
    return issue && issue.trim().length > 0 ? issue : null;
  }

  motd(): string | null {
    const motd = this.host.readFile('/etc/motd');
    return motd && motd.trim().length > 0 ? motd : null;
  }

  authPrompt(): TelnetAuthPrompt {
    return 'username-password';
  }

  credentialPrompts(): { readonly username: string; readonly password: string } {
    return { username: `${this.host.hostname()} login: `, password: 'Password: ' };
  }

  maxAuthAttempts(): number {
    return LOGIN_MAX_TRIES;
  }

  authFailureMessage(): string {
    return 'Login incorrect';
  }

  admit(sourceIp: string): TelnetAdmission {
    this.sourceIp = sourceIp;
    if (!this.host.telnetActive()) {
      return { accept: false, kind: 'transport', reason: 'telnetd inactive' };
    }
    return { accept: true };
  }

  authenticate(username: string | null, password: string): boolean {
    this.attempts += 1;
    if (username === null) return false;
    const ok = this.host.authenticate(username, password);
    if (!ok) {
      this.host.recordAuthFailure(username, this.sourceIp, this.attempts, 'Authentication failure');
    }
    return ok;
  }

  createShell(username: string | null): TelnetVtyShell | null {
    if (username === null) return null;
    const account = this.host.account(username);
    if (!account) return null;
    const host = this.host;
    let ended = false;
    const cwd = account.home;
    return {
      execute: async (rawInput: string): Promise<string> => {
        const line = rawInput.trim();
        if (line === 'exit' || line === 'logout') { ended = true; return 'logout'; }
        if (line.length === 0) return '';
        return host.runLine(username, line);
      },
      getPrompt: () => `${username}@${host.hostname()}:${cwd === account.home ? '~' : cwd}$ `,
      lastEndedSession: () => ended,
    };
  }

  openSession(username: string, fromIp: string, peerPort: number): TelnetSessionHandle | null {
    const handle = this.host.openSession(username, fromIp, peerPort);
    if (handle) {
      const account = this.host.account(username);
      this.host.recordLogin(username, fromIp, handle.line, account?.uid ?? 1000);
    }
    return handle;
  }

  closeSession(id: string, reason: string): void {
    this.host.closeSession(id, reason);
  }
}
