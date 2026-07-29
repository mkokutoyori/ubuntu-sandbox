/**
 * RouterTelnetServerContext — adapter exposing a Cisco IOS / Huawei VRP
 * router to the shared {@link TelnetServerHandler}.
 *
 * Everything it answers with is read from state the device already owns:
 * the VTY line blocks (`login` / `authentication-mode`, `password`,
 * `exec-timeout`), the credential store, the AAA method list, the banner
 * texts and the VTY line pool. Nothing here duplicates the SSH daemon's
 * policy — both go through `vtyAdmissionVerdict` and the same registry,
 * so an ACL or an exhausted pool refuses both transports identically.
 */

import type {
  ITelnetServerContext, TelnetAdmission, TelnetAuthPrompt,
  TelnetSessionHandle, TelnetVtyShell,
} from './ITelnetServerContext';

export interface RouterTelnetServerDeps {
  hostname(): string;
  /** `login` mode of the first configured VTY block, vendor-neutral. */
  loginMode(): 'none' | 'local' | 'aaa' | 'password';
  /** `password …` set on the line, used when the mode is `password`. */
  linePassword(): string | null;
  authHeader(): string | null;
  loginBanner(): string | null;
  motd(): string | null;
  admit(sourceIp: string): TelnetAdmission;
  authenticateLocal(username: string, password: string): boolean;
  authenticateAaa(username: string, password: string): Promise<boolean>;
  createVtyShell(username?: string): TelnetVtyShell;
  openSession(username: string, fromIp: string, peerPort: number): TelnetSessionHandle | null;
  closeSession(id: string, reason: string): void;
  touchSession(id: string, bytesIn: number, bytesOut: number): void;
  idleTimeoutMs(): number | null;
  recordAuthFailure(username: string, fromIp: string): void;
  recordLogin(username: string, fromIp: string): void;
}

export class RouterTelnetServerContext implements ITelnetServerContext {
  constructor(private readonly deps: RouterTelnetServerDeps) {}

  hostname(): string { return this.deps.hostname(); }
  banner(): string | null { return this.deps.loginBanner(); }
  motd(): string | null { return this.deps.motd(); }
  authHeader(): string | null {
    return this.authPrompt() === 'none' ? null : this.deps.authHeader();
  }

  authPrompt(): TelnetAuthPrompt {
    switch (this.deps.loginMode()) {
      case 'local':
      case 'aaa': return 'username-password';
      case 'password': return 'password';
      default: return 'none';
    }
  }

  admit(sourceIp: string): TelnetAdmission { return this.deps.admit(sourceIp); }

  async authenticate(username: string | null, password: string): Promise<boolean> {
    switch (this.deps.loginMode()) {
      case 'password': {
        const expected = this.deps.linePassword();
        return expected !== null && password === expected;
      }
      case 'local': return this.deps.authenticateLocal(username ?? '', password);
      case 'aaa': return this.deps.authenticateAaa(username ?? '', password);
      default: return true;
    }
  }

  createShell(username: string | null): TelnetVtyShell {
    return this.deps.createVtyShell(username ?? undefined);
  }

  openSession(username: string, fromIp: string, peerPort: number): TelnetSessionHandle | null {
    return this.deps.openSession(username, fromIp, peerPort);
  }

  closeSession(id: string, reason: string): void { this.deps.closeSession(id, reason); }
  touchSession(id: string, bytesIn: number, bytesOut: number): void {
    if (id) this.deps.touchSession(id, bytesIn, bytesOut);
  }
  idleTimeoutMs(): number | null { return this.deps.idleTimeoutMs(); }
  recordAuthFailure(username: string, fromIp: string): void { this.deps.recordAuthFailure(username, fromIp); }
  recordLogin(username: string, fromIp: string): void { this.deps.recordLogin(username, fromIp); }
}
