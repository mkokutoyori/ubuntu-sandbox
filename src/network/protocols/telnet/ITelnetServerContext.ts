/**
 * ITelnetServerContext — what {@link TelnetServerHandler} needs from the
 * device hosting it.
 *
 * Same inversion as `ISshServerContext`: the handler owns RFC 854 framing
 * and the login dialog, the device owns identity, admission policy, the
 * VTY line pool and the CLI shell. A vendor adapter
 * ({@link RouterTelnetServerContext}) is the only place that knows what a
 * Cisco or a Huawei is.
 */

/**
 * The per-session CLI shell — structurally what `Router.createVtyShell()`
 * already returns, so telnet and SSH drive one and the same object rather
 * than each growing a shell of its own.
 */
export interface TelnetVtyShell {
  execute(rawInput: string): string | Promise<string>;
  getPrompt(): string;
  lastEndedSession(): boolean;
  subscribeAsyncOutput?(sink: (line: string) => void): () => void;
  dispose?(): void;
}

/** Which credentials the line asks for before opening an EXEC session. */
export type TelnetAuthPrompt = 'none' | 'password' | 'username-password';

export interface TelnetAdmission {
  readonly accept: boolean;
  readonly kind?: 'acl' | 'line-password' | 'no-line' | 'quiet-mode' | 'transport';
  readonly reason?: string;
}

export interface TelnetSessionHandle {
  readonly id: string;
  readonly line: string;
}

export interface ITelnetServerContext {
  hostname(): string;
  /** `banner login` / `header login` text, shown before authentication. */
  banner(): string | null;
  /** `banner motd` / `header shell` text, shown once authenticated. */
  motd?(): string | null;
  /** Header IOS prints above the credential prompts, e.g. "User Access Verification". */
  authHeader?(): string | null;
  authPrompt(): TelnetAuthPrompt;
  /**
   * The two credential prompts in this vendor's own wording. IOS asks
   * `Username:`/`Password:`, a FortiGate asks `<hostname> login:`.
   * Absent leaves the IOS wording, which every existing caller relies on.
   */
  credentialPrompts?(): { readonly username: string; readonly password: string };
  /** ACL / quiet-mode / free-line verdict, evaluated before any prompt. */
  admit(sourceIp: string): TelnetAdmission;
  authenticate(username: string | null, password: string): boolean | Promise<boolean>;
  /** Attempts allowed before the server drops the connection (IOS: 3). */
  maxAuthAttempts?(): number;
  createShell(username: string | null): TelnetVtyShell | null;
  /** Claims a VTY line; `null` when the pool is exhausted. */
  openSession(username: string, fromIp: string, peerPort: number): TelnetSessionHandle | null;
  /**
   * The terminal type the client announced. Learned from a
   * subnegotiation that can land either side of the line being claimed,
   * so it is reported whenever it arrives rather than at open time.
   */
  noteTerminalType?(id: string, terminalType: string): void;
  closeSession(id: string, reason: string): void;
  touchSession?(id: string, bytesIn: number, bytesOut: number): void;
  /** `exec-timeout` / `idle-timeout` of the line, in ms; `null` disables it. */
  idleTimeoutMs?(): number | null;
  recordAuthFailure?(username: string, fromIp: string): void;
  recordLogin?(username: string, fromIp: string): void;
}
