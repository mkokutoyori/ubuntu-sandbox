import type { TcpStack } from '../../../tcp/TcpStack';
import type { TcpStream } from '../../../tcp/types';
import type { AuthMethodType, ISshAuthContext } from '../../../protocols/ssh/auth/ISshAuthMethod';
import type { ISftpFileSystem } from '../../../protocols/ssh/sftp/ISftpFileSystem';
import { RouterSftpFileSystem } from '../../../protocols/ssh/sftp/RouterSftpFileSystem';
import { SshHostKey } from '../../../protocols/ssh/SshHostKey';
import { SshUserContext } from '../../../protocols/ssh/SshUserContext';
import {
  DEFAULT_SSH_SERVER_CONFIG,
  type ILinuxShell,
  type ISshServerContext,
  type SshServerConfig,
} from '../../../protocols/ssh/server/ISshServerContext';
import { SshServerHandler } from '../../../protocols/ssh/server/SshServerHandler';
import { TelnetServerHandler } from '../../../protocols/telnet/TelnetServerHandler';
import type {
  ITelnetServerContext, TelnetAdmission, TelnetAuthPrompt, TelnetSessionHandle,
  TelnetVtyShell,
} from '../../../protocols/telnet/ITelnetServerContext';
import type { ManagementPorts } from './ManagementAccess';

export interface ManagementCli {
  execute(line: string): string;
  getPrompt(): string;
  completions?(input: string): readonly string[];
}

export interface FirewallCliServerDeps {
  tcp(): TcpStack;
  hostname(): string;
  ports(): ManagementPorts;
  createCli(user: string): ManagementCli | null;
  authenticate(user: string, password: string, source: string): boolean;
  knownAdmin(user: string): boolean;
  refuseSource(source: string): boolean;
  idleTimeoutMs(): number | null;
  runningConfig(): string;
  onLogin(user: string, source: string): void;
  onLogout(user: string): void;
  onAuthFailure(user: string, source: string): void;
}

export class FirewallCliServer {
  private sshPort: number | null = null;
  private telnetPort: number | null = null;
  private hostKey: SshHostKey | null = null;
  private sessions = 0;

  constructor(private readonly deps: FirewallCliServerDeps) {}

  refresh(): void {
    const wanted = this.deps.ports();
    this.sshPort = this.rebind(this.sshPort, wanted.ssh, 'sshd',
      (socket) => this.serveSsh(socket));
    this.telnetPort = this.rebind(this.telnetPort, wanted.telnet, 'telnetd',
      (socket) => this.serveTelnet(socket));
  }

  detach(): void {
    const tcp = this.deps.tcp();
    if (this.sshPort !== null) tcp.closeListener(this.sshPort);
    if (this.telnetPort !== null) tcp.closeListener(this.telnetPort);
    this.sshPort = null;
    this.telnetPort = null;
  }

  private rebind(
    current: number | null, wanted: number, processName: string,
    serve: (socket: { remoteIp: string }) => void,
  ): number | null {
    if (current === wanted) return current;
    const tcp = this.deps.tcp();
    if (current !== null) tcp.closeListener(current);
    try {
      tcp.listen(wanted, {
        onAccept: (socket) => { serve(socket as { remoteIp: string }); },
        identity: { processName },
      });
    } catch {
      return null;
    }
    return wanted;
  }

  private serveSsh(socket: { remoteIp: string }): void {
    const context = new FirewallSshServerContext(this.deps, socket.remoteIp, this.key());
    new SshServerHandler(context)
      .register(socket as unknown as TcpStream, socket.remoteIp);
  }

  private serveTelnet(socket: { remoteIp: string }): void {
    const context = new FirewallTelnetServerContext(
      this.deps, socket.remoteIp, () => `line${this.sessions++}`);
    new TelnetServerHandler(context)
      .register(socket as unknown as TcpStream, socket.remoteIp);
  }

  private key(): SshHostKey {
    if (!this.hostKey) this.hostKey = SshHostKey.generate(this.deps.hostname());
    return this.hostKey;
  }
}

class FirewallSshServerContext implements ISshServerContext {
  readonly hostKey: SshHostKey;
  readonly config: Readonly<SshServerConfig>;
  readonly auth: ISshAuthContext;

  constructor(
    private readonly deps: FirewallCliServerDeps,
    private readonly source: string,
    hostKey: SshHostKey,
  ) {
    this.hostKey = hostKey;
    this.config = Object.freeze({ ...DEFAULT_SSH_SERVER_CONFIG, permitRootLogin: false });
    this.auth = this.buildAuthContext();
  }

  getFilesystem(): ISftpFileSystem {
    return new RouterSftpFileSystem({
      read: (path) => (path.includes('config') ? this.deps.runningConfig() : null),
      list: () => ['sys_config'],
    });
  }

  execIdleTimeoutMs(): number | null { return this.deps.idleTimeoutMs(); }

  getShell(userCtx: SshUserContext): ILinuxShell {
    const cli = this.deps.createCli(userCtx.username);
    if (!cli) {
      return {
        execute: async (line: string) => ({
          stdout: '', stderr: `${line}: no CLI on this device\n`, exitCode: 1,
        }),
      };
    }
    return {
      execute: async (line: string) => {
        const ends = closesSession(line, cli.getPrompt());
        const stdout = renderedLine(cli.execute(line));
        if (ends) this.deps.onLogout(userCtx.username);
        return { stdout, stderr: '', exitCode: 0, sessionEnded: ends };
      },
      getPrompt: () => cli.getPrompt(),
      getCompletions: cli.completions ? (line: string) => [...cli.completions!(line)] : undefined,
      supportsInlineHelp: true,
      posixShell: false,
    };
  }

  getMotd(): string { return ''; }
  getLastLogin(): string | null { return null; }

  recordLogin(user: string, fromIp: string): void { this.deps.onLogin(user, fromIp); }

  recordAuthFailure(user: string, fromIp: string): void {
    this.deps.onAuthFailure(user, fromIp);
  }

  buildUserContext(username: string): SshUserContext | null {
    return this.deps.knownAdmin(username)
      ? new SshUserContext(username, 0, 0, [], '/') : null;
  }

  isClientBlocked(ip: string): boolean { return this.deps.refuseSource(ip); }

  permitEmptyPasswords(): boolean { return false; }

  private buildAuthContext(): ISshAuthContext {
    let attemptsLeft = this.config.maxAuthTries;
    return {
      checkPassword: (user, password) => {
        attemptsLeft = Math.max(0, attemptsLeft - 1);
        return this.deps.authenticate(user, password, this.source);
      },
      checkPublicKey: () => false,
      getAttemptsRemaining: () => attemptsLeft,
      getAvailableMethods: (): readonly AuthMethodType[] => ['password'],
    };
  }
}

class FirewallTelnetServerContext implements ITelnetServerContext {
  private cli: ManagementCli | null = null;

  constructor(
    private readonly deps: FirewallCliServerDeps,
    private readonly source: string,
    private readonly nextLine: () => string,
  ) {}

  hostname(): string { return this.deps.hostname(); }
  banner(): string | null { return null; }
  authHeader(): string | null { return null; }
  authPrompt(): TelnetAuthPrompt { return 'username-password'; }

  credentialPrompts(): { username: string; password: string } {
    return { username: `${this.deps.hostname()} login: `, password: 'Password: ' };
  }

  admit(sourceIp: string): TelnetAdmission {
    return this.deps.refuseSource(sourceIp)
      ? { accept: false, kind: 'acl' } : { accept: true };
  }

  authenticate(username: string | null, password: string): boolean {
    if (username === null) return false;
    const accepted = this.deps.authenticate(username, password, this.source);
    if (!accepted) this.deps.onAuthFailure(username, this.source);
    return accepted;
  }

  maxAuthAttempts(): number { return 3; }

  createShell(username: string | null): TelnetVtyShell | null {
    this.cli = this.deps.createCli(username ?? '');
    const cli = this.cli;
    if (!cli) return null;
    let ended = false;
    return {
      execute: (raw: string) => {
        ended = closesSession(raw, cli.getPrompt());
        const rendered = renderedLine(cli.execute(raw));
        if (ended) this.deps.onLogout(username ?? '');
        return rendered;
      },
      getPrompt: () => cli.getPrompt(),
      lastEndedSession: () => ended,
    };
  }

  openSession(username: string, fromIp: string): TelnetSessionHandle | null {
    this.deps.onLogin(username, fromIp);
    const line = this.nextLine();
    return { id: line, line };
  }

  closeSession(): void { this.cli = null; }

  idleTimeoutMs(): number | null { return this.deps.idleTimeoutMs(); }
}

function renderedLine(text: string): string {
  if (text.length === 0) return '';
  return text.endsWith('\n') ? text : `${text}\n`;
}

function closesSession(line: string, prompt: string): boolean {
  const word = line.trim().toLowerCase();
  if (word !== 'exit' && word !== 'quit') return false;
  return !prompt.includes('(');
}
