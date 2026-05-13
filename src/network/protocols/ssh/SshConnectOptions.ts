/**
 * SshConnectOptions — immutable bundle of parameters for ssh client connect.
 * SshConnectOptionsBuilder — Builder pattern for stepwise construction.
 *
 * Reference: DESIGN-SSH-SFTP.md section 3 + 6.3.
 */

export type StrictHostKeyChecking = 'yes' | 'no' | 'accept-new';

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
    });
  }
}
