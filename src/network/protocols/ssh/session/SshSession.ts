/**
 * SshSession — Facade orchestrating host-key verification, authentication
 * and channel multiplexing on top of a TcpConnection.
 *
 * The state is a discriminated union; transition() replaces the value
 * rather than mutating fields, which keeps the lifecycle traceable.
 *
 * Reference: DESIGN-SSH-SFTP.md section 6.
 */

import type { ISshLocalFs } from '../ISshLocalFs';
import type {
  TcpStream as TcpConnection,
  TcpConnector,
} from '@/network/core/TcpConnection';
import { AuthChain, createAuthMethods } from '../auth/AuthChain';
import type { ISshAuthContext } from '../auth/ISshAuthMethod';
import type {
  ISshExecChannel,
  ISshSftpChannel,
  ISshShellChannel,
} from '../channels/ISshChannel';
import { SshChannelManager } from '../channels/SshChannelManager';
import type { IHostKeyVerificationStrategy } from '../hostkey/IHostKeyVerificationStrategy';
import { SshKnownHosts } from '../hostkey/SshKnownHosts';
import { createVerificationStrategy } from '../hostkey/VerificationStrategies';
import { type Result, err, ok, propagateErr } from '../Result';
import type { SshConnectOptions } from '../SshConnectOptions';
import { SshHostKey } from '../SshHostKey';
import {
  type ISshInteractionHandler,
  type SshConnectionInfo,
} from './ISshInteractionHandler';
import type { ISshSession } from './ISshSession';
import {
  type SshSessionState,
  authenticating,
  connected,
  connecting,
  disconnected,
  idle,
  verifyingHostKey,
} from './SshSessionState';

export interface SshSessionDeps {
  readonly tcpConnector: TcpConnector;
  readonly vfs: ISshLocalFs;
  readonly localUser: string;
  readonly localUid: number;
  readonly localGid: number;
  readonly knownHostsPath: string;
  readonly interactionHandler: ISshInteractionHandler;
}

interface ServerBanner {
  readonly hostKey: { algorithm: string; publicKey: string };
  readonly serverVersion: string;
  readonly preAuthBanner?: string;
}

export class SshSession implements ISshSession {
  private _state: SshSessionState = idle();
  private conn: TcpConnection | null = null;
  private channelManager = new SshChannelManager();
  private knownHosts: SshKnownHosts;

  constructor(private readonly deps: SshSessionDeps) {
    this.knownHosts = new SshKnownHosts(
      deps.vfs,
      deps.knownHostsPath,
      deps.localUid,
      deps.localGid,
    );
  }

  get state(): SshSessionState {
    return this._state;
  }

  get isConnected(): boolean {
    return this._state.kind === 'connected';
  }

  async connect(
    opts: SshConnectOptions,
  ): Promise<Result<SshConnectionInfo>> {
    this.transition(connecting(opts.host, opts.port));

    const conn = await this.deps.tcpConnector(opts.host, opts.port);
    if (!conn) {
      this.transition(disconnected('connection refused'));
      return err({
        kind: 'CONNECTION_REFUSED',
        host: opts.host,
        port: opts.port,
      });
    }
    this.conn = conn;

    const banner = await this.exchangeBanner(conn);
    if (!banner.ok) {
      this.transition(disconnected('protocol error'));
      conn.close();
      this.conn = null;
      return propagateErr(banner);
    }
    if (banner.value.preAuthBanner) {
      this.deps.interactionHandler.showInfo(banner.value.preAuthBanner);
    }
    const hostKey = SshHostKey.fromFiles(
      banner.value.hostKey.publicKey,
      '',
      banner.value.hostKey.algorithm as 'ssh-ed25519',
    );

    const verifyResult = await this.doHostKeyCheck(opts.host, hostKey, opts);
    if (!verifyResult.ok) {
      this.transition(disconnected('host key rejected'));
      conn.close();
      this.conn = null;
      return propagateErr(verifyResult);
    }

    this.transition(authenticating(opts.user, opts.host, 3));
    const authResult = await this.doAuthenticate(opts.user, conn, opts);
    if (!authResult.ok) {
      this.transition(disconnected('authentication failed'));
      conn.close();
      this.conn = null;
      return propagateErr(authResult);
    }

    const sessionId = `${opts.user}@${opts.host}:${opts.port}#${Date.now()}`;
    this.transition(connected(opts.user, opts.host, sessionId));

    const info: SshConnectionInfo = {
      host: opts.host,
      user: opts.user,
      port: opts.port,
      sessionId,
      hostFingerprint: hostKey.fingerprint,
      connectedAt: Date.now(),
    };
    this.deps.interactionHandler.onConnected(info);
    return ok(info);
  }

  openShellChannel(): Result<ISshShellChannel> {
    if (!this.conn || !this.isConnected) {
      return err({ kind: 'NOT_AUTHENTICATED' });
    }
    const channel: ISshShellChannel = this.channelManager.openShell(this.conn);
    return ok(channel);
  }

  openExecChannel(command: string): Result<ISshExecChannel> {
    if (!this.conn || !this.isConnected) {
      return err({ kind: 'NOT_AUTHENTICATED' });
    }
    const channel: ISshExecChannel = this.channelManager.openExec(
      this.conn,
      command,
    );
    return ok(channel);
  }

  openSftpChannel(): Result<ISshSftpChannel> {
    if (!this.conn || !this.isConnected) {
      return err({ kind: 'NOT_AUTHENTICATED' });
    }
    const channel: ISshSftpChannel = this.channelManager.openSftp(this.conn);
    return ok(channel);
  }

  disconnect(): void {
    this.channelManager.closeAll();
    this.conn?.close();
    this.conn = null;
    this.transition(disconnected('client disconnected'));
  }

  // ─── private ────────────────────────────────────────────────────────

  private transition(next: SshSessionState): void {
    this._state = next;
  }

  private async exchangeBanner(
    conn: TcpConnection,
  ): Promise<Result<ServerBanner>> {
    let banner: ServerBanner | null = null;
    const off = conn.onData((data) => {
      try {
        const parsed = JSON.parse(data) as Partial<ServerBanner>;
        if (parsed.hostKey && parsed.serverVersion) {
          banner = parsed as ServerBanner;
        }
      } catch {
        /* ignore non-JSON banner traffic */
      }
    });
    conn.write(JSON.stringify({ op: 'hello', clientVersion: 'SSH-2.0-Sandbox' }));
    off();
    if (!banner) {
      return err({ kind: 'IO_ERROR', message: 'no server banner' });
    }
    return ok(banner);
  }

  private async doHostKeyCheck(
    host: string,
    key: SshHostKey,
    opts: SshConnectOptions,
  ): Promise<Result<void>> {
    const strategy: IHostKeyVerificationStrategy = createVerificationStrategy(
      opts.strictHostKeyChecking,
    );
    const store = this.knownHosts.load();
    const decision = strategy.verify(host, key, store);

    switch (decision.action) {
      case 'accept_silent':
        return ok(undefined);

      case 'accept_and_save':
        this.knownHosts.addHost(host, key, { hashed: opts.hashKnownHosts });
        this.deps.interactionHandler.showInfo(
          `Warning: Permanently added '${host}' (${key.algorithm}) to the list of known hosts.`,
        );
        return ok(undefined);

      case 'prompt': {
        this.transition(verifyingHostKey(host, decision.fingerprint));
        const reply =
          await this.deps.interactionHandler.promptHostKeyConfirmation(
            host,
            decision.fingerprint,
          );
        switch (reply.kind) {
          case 'yes':
            this.knownHosts.addHost(host, key, { hashed: opts.hashKnownHosts });
            return ok(undefined);
          case 'fingerprint':
            // SSH-01-R6: accept silently when the user types the exact
            // fingerprint, but do NOT persist to known_hosts.
            if (reply.value === decision.fingerprint) return ok(undefined);
            return err({
              kind: 'HOST_KEY_REJECTED',
              host,
              fingerprint: decision.fingerprint,
            });
          case 'no':
            return err({
              kind: 'HOST_KEY_REJECTED',
              host,
              fingerprint: decision.fingerprint,
            });
        }
      }

      case 'reject': {
        this.deps.interactionHandler.showWarning(decision.warningBlock);
        const known = store.get(host);
        return err({
          kind: 'HOST_KEY_CHANGED',
          host,
          expected: known?.fingerprint.toString() ?? '',
          got: key.fingerprint.toString(),
        });
      }
    }
  }

  private async doAuthenticate(
    user: string,
    conn: TcpConnection,
    opts: SshConnectOptions,
  ): Promise<Result<void>> {
    const ctx = this.makeAuthContext(conn, user, opts);
    // Track the number of password prompts already issued so we only emit
    // "Permission denied, please try again." between attempts, never before
    // the first prompt — matches OpenSSH 9.x exactly.
    let promptsIssued = 0;
    const passwordProvider = async (
      currentUser: string,
      _attemptsLeft: number,
    ): Promise<string> => {
      if (promptsIssued > 0) {
        this.deps.interactionHandler.showAuthFailure?.(currentUser, opts.host);
      }
      promptsIssued++;
      if (opts.password !== undefined) return opts.password;
      return this.deps.interactionHandler.promptPassword(currentUser, opts.host);
    };
    const methods = createAuthMethods(this.deps.vfs, opts, passwordProvider);
    const chain = AuthChain.create(methods);

    const result = await chain.tryAll(user, ctx);
    if (!result.ok) {
      this.deps.interactionHandler.showWarning(
        `${user}@${opts.host}: Permission denied (${chain.toDisplayString()}).`,
      );
    }
    return result;
  }

  private makeAuthContext(
    conn: TcpConnection,
    _user: string,
    _opts: SshConnectOptions,
  ): ISshAuthContext {
    let attemptsLeft = 3;
    return {
      checkPassword: () => false,
      checkPasswordAsync: async (u, password) => {
        attemptsLeft = Math.max(0, attemptsLeft - 1);
        const response = await this.requestServerAuth(conn, {
          op: 'auth',
          method: 'password',
          user: u,
          password,
        });
        return response.ok === true;
      },
      checkPublicKey: () => false,
      checkPublicKeyAsync: async (u, publicKey) => {
        const response = await this.requestServerAuth(conn, {
          op: 'auth',
          method: 'publickey',
          user: u,
          publicKey,
        });
        return response.ok === true;
      },
      getAttemptsRemaining: () => attemptsLeft,
      getAvailableMethods: () => ['publickey', 'password'],
    };
  }

  private requestServerAuth(
    conn: TcpConnection,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean }> {
    return new Promise((resolve) => {
      const off = conn.onData((data) => {
        try {
          const parsed = JSON.parse(data) as { ok?: boolean };
          if (typeof parsed.ok === 'boolean') {
            off();
            resolve({ ok: parsed.ok });
          }
        } catch {
          /* ignore */
        }
      });
      conn.write(JSON.stringify(payload));
    });
  }
}
