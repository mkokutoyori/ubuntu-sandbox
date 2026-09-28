/**
 * SshConnectOptions — immutable bundle of parameters for ssh client connect.
 * SshConnectOptionsBuilder — Builder pattern for stepwise construction.
 *
 * Reference: DESIGN-SSH-SFTP.md section 3 + 6.3.
 */

import type { AuthMethodType } from './auth/ISshAuthMethod';

export type StrictHostKeyChecking = 'yes' | 'no' | 'accept-new';

export const OPENSSH_USERAUTH_METHODS: readonly AuthMethodType[] = ['publickey', 'keyboard-interactive', 'password'];

export const OPENSSH_DEFAULT_IDENTITY_FILES: readonly string[] = [
  'id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk', 'id_xmss', 'id_dsa',
];

export interface SshClientAuthentication {
  readonly preferred: readonly string[] | null;
  readonly publickey: boolean;
  readonly keyboardInteractive: boolean;
  readonly password: boolean;
  readonly batchMode: boolean;
  readonly passwordPrompts: number;
}

export const OPENSSH_CLIENT_AUTHENTICATION: SshClientAuthentication = Object.freeze({
  preferred: null,
  publickey: true,
  keyboardInteractive: true,
  password: true,
  batchMode: false,
  passwordPrompts: 3,
});

const SSH_OPTION_ALIASES: Readonly<Record<string, string>> = {
  challengeresponseauthentication: 'kbdinteractiveauthentication',
};

function sshOptionAssignment(raw: string): { name: string; value: string } | null {
  const match = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)(.*?)\s*$/.exec(raw);
  if (!match) return null;
  const name = match[1].toLowerCase();
  return { name: SSH_OPTION_ALIASES[name] ?? name, value: match[2] };
}

function sshFlag(value: string): boolean | null {
  const lowered = value.toLowerCase();
  if (lowered === 'yes' || lowered === 'true') return true;
  if (lowered === 'no' || lowered === 'false') return false;
  return null;
}

export function sshClientAuthentication(optionValues: readonly string[]): SshClientAuthentication {
  const seen = new Map<string, string>();
  for (const raw of optionValues) {
    const assignment = sshOptionAssignment(raw);
    if (assignment && !seen.has(assignment.name)) seen.set(assignment.name, assignment.value);
  }
  const flag = (name: string, fallback: boolean): boolean => {
    const value = seen.get(name);
    return value === undefined ? fallback : sshFlag(value) ?? fallback;
  };
  const preferred = seen.get('preferredauthentications');
  const prompts = Number.parseInt(seen.get('numberofpasswordprompts') ?? '', 10);
  const defaults = OPENSSH_CLIENT_AUTHENTICATION;
  return Object.freeze({
    preferred: preferred === undefined ? null : Object.freeze(preferred.split(',').map((m) => m.trim()).filter(Boolean)),
    publickey: flag('pubkeyauthentication', defaults.publickey),
    keyboardInteractive: flag('kbdinteractiveauthentication', defaults.keyboardInteractive),
    password: flag('passwordauthentication', defaults.password),
    batchMode: flag('batchmode', defaults.batchMode),
    passwordPrompts: Number.isInteger(prompts) && prompts >= 0 ? prompts : defaults.passwordPrompts,
  });
}

export function sshOptionValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' && args[i + 1] !== undefined) values.push(args[++i]);
    else if (args[i].startsWith('-o') && args[i].length > 2) values.push(args[i].slice(2));
  }
  return values;
}

export interface SshConnectOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly identityFiles: readonly string[];
  readonly strictHostKeyChecking: StrictHostKeyChecking;
  readonly timeoutMs: number;
  readonly password?: string;
  /** Mirrors OpenSSH `HashKnownHosts`. When `true`, new entries appended to
   *  `~/.ssh/known_hosts` use the `|1|<salt>|<hash>` shape. */
  readonly hashKnownHosts?: boolean;
  /**
   * OpenSSH `-t` / `-T` / `-tt`. `'yes'` requests a PTY, `'force'` insists
   * even when stdin is not a TTY, `'no'` disables. `undefined` lets the
   * server pick the default (PTY for interactive, none for exec).
   */
  readonly requestTty?: 'yes' | 'no' | 'force';
  readonly authentication: SshClientAuthentication;
}

export class SshConnectOptionsBuilder {
  private _host?: string;
  private _user?: string;
  private _port = 22;
  private _identityFiles: string[] = [];
  private _strict: StrictHostKeyChecking = 'yes';
  private _timeoutMs = 30_000;
  private _password?: string;
  private _hashKnownHosts?: boolean;
  private _requestTty?: 'yes' | 'no' | 'force';
  private _authentication: SshClientAuthentication = OPENSSH_CLIENT_AUTHENTICATION;

  static create(): SshConnectOptionsBuilder {
    return new SshConnectOptionsBuilder();
  }

  host(h: string): this {
    this._host = h;
    return this;
  }

  port(p: number): this {
    this._port = p;
    return this;
  }

  user(u: string): this {
    this._user = u;
    return this;
  }

  addIdentityFile(path: string): this {
    this._identityFiles.push(path);
    return this;
  }

  strictHostKeyChecking(mode: StrictHostKeyChecking): this {
    this._strict = mode;
    return this;
  }

  timeoutMs(ms: number): this {
    this._timeoutMs = ms;
    return this;
  }

  password(pw: string): this {
    this._password = pw;
    return this;
  }

  hashKnownHosts(yes: boolean): this {
    this._hashKnownHosts = yes;
    return this;
  }

  requestTty(mode: 'yes' | 'no' | 'force'): this {
    this._requestTty = mode;
    return this;
  }

  authentication(auth: SshClientAuthentication): this {
    this._authentication = auth;
    return this;
  }

  build(): SshConnectOptions {
    if (!this._host) throw new Error('SshConnectOptions: host is required');
    if (!this._user) throw new Error('SshConnectOptions: user is required');
    return Object.freeze({
      host: this._host,
      port: this._port,
      user: this._user,
      identityFiles: Object.freeze([...this._identityFiles]),
      strictHostKeyChecking: this._strict,
      timeoutMs: this._timeoutMs,
      password: this._password,
      hashKnownHosts: this._hashKnownHosts,
      requestTty: this._requestTty,
      authentication: this._authentication,
    });
  }
}
