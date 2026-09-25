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
} from '@/network/tcp/types';
import { isDialFailure } from '@/network/tcp/types';
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
import {
  SshRecordLayer, sealedStream, generateEphemeralScalar,
  ephemeralPublicKey, sharedSecretFrom,
} from '../transport/SshRecordLayer';

export interface SshSessionDeps {
  readonly tcpConnector: TcpConnector;
  readonly vfs: ISshLocalFs;
  readonly localUser: string;
  readonly localUid: number;
  readonly localGid: number;
  readonly knownHostsPath: string;
  readonly credentialless?: boolean;
  readonly interactionHandler: ISshInteractionHandler;
}

interface ServerBanner {
  readonly hostKey: { algorithm: string; publicKey: string };
  readonly serverVersion: string;
  readonly preAuthBanner?: string;
}


export const SSH_PASSWORD_PROMPTS = 3;

export class SshSession implements ISshSession {
  private _state: SshSessionState = idle();
  private conn: TcpConnection | null = null;
  private readonly records = new SshRecordLayer();

  revealWireRecord(frame: string): string | null {
    return this.records.reveal(frame);
  }

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

    const dialed = await this.deps.tcpConnector(opts.host, opts.port);
    if (!dialed || isDialFailure(dialed)) {
      const reason = isDialFailure(dialed) ? dialed.dialFailed : 'refused';
      this.transition(disconnected(
        reason === 'timeout' ? 'connection timed out'
          : reason === 'unreachable' ? 'network is unreachable'
            : 'connection refused'));
      return err({
        kind: reason === 'timeout' ? 'CONNECTION_TIMEOUT'
          : reason === 'unreachable' ? 'CONNECTION_UNREACHABLE'
            : 'CONNECTION_REFUSED',
        host: opts.host,
        port: opts.port,
      });
    }
    dialed.setNoDelay?.(true);
    const records = this.records;
    const conn = sealedStream(dialed, records);
    this.conn = conn;

    const banner = await this.exchangeBanner(conn, records);
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

    // Follow our own transport from here on. A session that does not
    // notice its socket dying reports itself connected forever, which
    // pushes every consumer into probing with a fresh handshake just to
    // find out — and that is what made a remote log an accept/close
    // pair per command.
    conn.onClose?.((reason) => {
      if (this._state.kind === 'connected') {
        this.transition(disconnected(reason || 'connection closed'));
      }
      this.conn = null;
    });

    const sessionId = `${opts.user}@${opts.host}:${opts.port}#${Date.now()}`;
    this.transition(connected(opts.user, opts.host, sessionId));

    conn.onData((data) => {
      try {
        const msg = JSON.parse(data) as { op?: string };
        if (msg.op === 'keepalive') {
          conn.write(JSON.stringify({ op: 'keepalive_ack' }));
        }
      } catch { /* not JSON or not keepalive — channel layers handle it */ }
    });

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

  openDirectTcpip(host: string, port: number): Promise<Result<TcpConnection>> {
    const conn = this.conn;
    if (!conn || !this.isConnected) return Promise.resolve(err({ kind: 'NOT_AUTHENTICATED' }));
    const dataHandlers: Array<(data: string) => void> = [];
    const closeHandlers: Array<(reason: string) => void> = [];
    let open = true;
    const finish = (reason: string): void => {
      if (!open) return;
      open = false;
      offFrames();
      offConn?.();
      for (const handler of closeHandlers) handler(reason);
    };
    let settle: ((result: Result<TcpConnection>) => void) | null = null;
    const stream: TcpConnection = {
      localIp: conn.localIp,
      localPort: conn.localPort,
      remoteIp: host,
      remotePort: port,
      write: (data) => { if (open) conn.write(JSON.stringify({ op: 'tcpip_data', data })); },
      close: () => {
        if (open) conn.write(JSON.stringify({ op: 'tcpip_eof' }));
        finish('fin');
      },
      onData: (handler) => {
        dataHandlers.push(handler);
        return () => { dataHandlers.splice(dataHandlers.indexOf(handler), 1); };
      },
      onClose: (handler) => {
        closeHandlers.push(handler);
        return () => { closeHandlers.splice(closeHandlers.indexOf(handler), 1); };
      },
    };
    const offFrames = conn.onData((frame) => {
      let parsed: { op?: string; ok?: boolean; reason?: string; data?: string };
      try { parsed = JSON.parse(frame) as typeof parsed; } catch { return; }
      if (parsed.op === 'tcpip_data') {
        for (const handler of [...dataHandlers]) handler(String(parsed.data ?? ''));
      } else if (parsed.op === 'tcpip_eof') {
        finish('fin');
      } else if (parsed.op === 'direct_tcpip_reply' && settle) {
        const reply = settle;
        settle = null;
        if (parsed.ok === true) {
          reply(ok(stream));
        } else {
          open = false;
          offFrames();
          offConn?.();
          reply(err({ kind: 'CHANNEL_ERROR', channelId: 0, message: parsed.reason ?? 'open failed' }));
        }
      }
    });
    const offConn = conn.onClose?.(() => {
      if (settle) {
        const reply = settle;
        settle = null;
        reply(err({ kind: 'CHANNEL_ERROR', channelId: 0, message: 'connection closed' }));
      }
      finish('fin');
    });
    return new Promise((resolve) => {
      settle = resolve;
      conn.write(JSON.stringify({ op: 'direct_tcpip', host, port }));
    });
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
    records: SshRecordLayer,
  ): Promise<Result<ServerBanner>> {
    let banner: (ServerBanner & { kexPublicKey?: string }) | null = null;
    const off = conn.onData((data) => {
      try {
        const parsed = JSON.parse(data) as Partial<ServerBanner & { kexPublicKey?: string }>;
        if (parsed.hostKey && parsed.serverVersion) {
          banner = parsed as ServerBanner & { kexPublicKey?: string };
        }
      } catch {
        /* ignore non-JSON banner traffic */
      }
    });
    const scalar = generateEphemeralScalar();
    conn.write(JSON.stringify({
      op: 'hello',
      clientVersion: 'SSH-2.0-Sandbox',
      kexPublicKey: ephemeralPublicKey(scalar),
    }));
    off();
    if (!banner) {
      return err({ kind: 'IO_ERROR', message: 'no server banner' });
    }
    const peerKey = (banner as { kexPublicKey?: string }).kexPublicKey;
    if (peerKey) {
      const secret = sharedSecretFrom(scalar, peerKey);
      if (secret) records.install(secret, 'client');
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
    const suppliedOnce = opts.password !== undefined
      || this.deps.interactionHandler.canPromptAgain?.() === false;
    const prompts = suppliedOnce ? 1 : 3;
    const methods = createAuthMethods(this.deps.vfs, opts, passwordProvider, prompts);
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
    let attemptsLeft = SSH_PASSWORD_PROMPTS;
    return {
      checkPassword: () => false,
      checkPasswordAsync: async (u, password) => {
        attemptsLeft = Math.max(0, attemptsLeft - 1);
        const response = await this.requestServerAuth(conn, {
          op: 'auth',
          method: 'password',
          user: u,
          ...(this.deps.credentialless === true && password === ''
            ? {}
            : { password }),
        });
        if (response.ended) attemptsLeft = 0;
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
        if (response.ended) attemptsLeft = 0;
        return response.ok === true;
      },
      getAttemptsRemaining: () => attemptsLeft,
      getAvailableMethods: () => ['publickey', 'password'],
    };
  }

  private requestServerAuth(
    conn: TcpConnection,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; ended: boolean }> {
    return new Promise((resolve) => {
      let settled = false;
      const offData = conn.onData((data) => {
        if (settled) return;
        try {
          const parsed = JSON.parse(data) as { ok?: boolean; ended?: boolean };
          if (typeof parsed.ok === 'boolean') {
            settled = true;
            offData();
            offClose?.();
            resolve({ ok: parsed.ok, ended: parsed.ended === true });
          }
        } catch {
          /* ignore */
        }
      });
      const offClose = conn.onClose?.(() => {
        if (settled) return;
        settled = true;
        offData();
        resolve({ ok: false, ended: true });
      });
      conn.write(JSON.stringify(payload));
    });
  }
}
