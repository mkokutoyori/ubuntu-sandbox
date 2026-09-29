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
import {
  runUserauth,
  type UserauthIdentity,
  type UserauthInfoRequest,
  type UserauthOutcome,
  type UserauthPrompt,
  type UserauthReply,
  type UserauthTransport,
} from '../auth/ClientUserauth';
import { SshKeyPair } from '../SshKeyPair';
import { signUserauth, userauthSignatureAlgorithm, userauthSignedData } from '../auth/UserauthSignature';
import {
  keygenPrivateKey, sshPublicKeyBlob, sshPublicKeyFromBlob,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { base64ToBytes, bytesToBase64 } from '@/crypto/encoding';
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
import { OPENSSH_CLIENT_AUTHENTICATION, type SshConnectOptions } from '../SshConnectOptions';
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
  ephemeralPublicKey, sharedSecretFrom, exchangeHash,
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


export const SSH_PASSWORD_PROMPTS = OPENSSH_CLIENT_AUTHENTICATION.passwordPrompts;

const SSH_CLIENT_IDENTIFICATION = 'SSH-2.0-Sandbox';

export class SshSession implements ISshSession {
  private _state: SshSessionState = idle();
  private conn: TcpConnection | null = null;
  private readonly records = new SshRecordLayer();
  private sessionId: Uint8Array | null = null;

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
    const clientEphemeral = ephemeralPublicKey(scalar);
    conn.write(JSON.stringify({
      op: 'hello',
      clientVersion: SSH_CLIENT_IDENTIFICATION,
      kexPublicKey: clientEphemeral,
    }));
    off();
    if (!banner) {
      return err({ kind: 'IO_ERROR', message: 'no server banner' });
    }
    const received: ServerBanner & { kexPublicKey?: string } = banner;
    const peerKey = received.kexPublicKey;
    if (peerKey) {
      const secret = sharedSecretFrom(scalar, peerKey);
      if (secret) {
        records.install(secret, 'client');
        this.sessionId = exchangeHash({
          clientVersion: SSH_CLIENT_IDENTIFICATION,
          serverVersion: received.serverVersion,
          hostKeyBlob: received.hostKey.publicKey,
          clientEphemeral,
          serverEphemeral: peerKey,
          sharedSecret: secret,
        });
      }
    }
    return ok(received);
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
    const handler = this.deps.interactionHandler;
    const suppliedOnce = opts.password !== undefined || handler.canPromptAgain?.() === false;
    let answersGiven = 0;
    const answer = (ask: () => Promise<string>): Promise<string> => {
      answersGiven++;
      return opts.password !== undefined ? Promise.resolve(opts.password) : ask();
    };
    let closed = false;
    const offClosed = conn.onClose?.(() => { closed = true; });
    const outcome = await runUserauth(this.userauthTransport(conn, user, () => closed), {
      authentication: opts.authentication,
      identities: this.userauthIdentities(opts, user),
      interactive: this.deps.credentialless !== true,
    }, {
      canAnswer: () => !suppliedOnce || answersGiven === 0,
      password: () => answer(() => handler.promptPassword(user, opts.host)),
      keyboardInteractive: ({ prompt, echo }) => answer(() => {
        const shown = `(${user}@${opts.host}) ${prompt}`;
        return handler.promptKeyboardInteractive?.(shown, echo) ?? handler.promptPassword(user, opts.host);
      }),
      retry: () => handler.showAuthFailure?.(user, opts.host),
      inform: (text) => handler.showInfo(text),
    }).finally(() => offClosed?.());
    if (outcome.kind === 'success') return ok(undefined);
    handler.showWarning(userauthFailureLines(outcome, user, opts.host, opts.port));
    return err({
      kind: 'AUTH_FAILED', user, attemptsLeft: 0,
      ...(outcome.kind === 'denied' ? { methods: outcome.methods } : {}),
    });
  }

  private userauthIdentities(opts: SshConnectOptions, user: string): UserauthIdentity[] {
    const identities: UserauthIdentity[] = [];
    for (const path of opts.identityFiles) {
      const pair = SshKeyPair.fromVfs(this.deps.vfs, path);
      if (!pair.ok) continue;
      let blob: Uint8Array;
      try { blob = base64ToBytes(pair.value.publicKeyContent); } catch { continue; }
      const publicKey = sshPublicKeyFromBlob(blob);
      if (publicKey === null) continue;
      const algorithm = userauthSignatureAlgorithm(publicKey);
      identities.push({
        algorithm,
        publicKey: pair.value.publicKeyContent,
        sign: () => this.signUserauthRequest(path, user, algorithm, blob),
      });
    }
    return identities;
  }

  private signUserauthRequest(path: string, user: string, algorithm: string, blob: Uint8Array): string | null {
    const handler = this.deps.interactionHandler;
    const key = keygenPrivateKey(this.deps.vfs.readFile(path) ?? '');
    if (key === null) {
      handler.showWarning(`Load key "${path}": invalid format`);
      return null;
    }
    if (bytesToBase64(sshPublicKeyBlob(key)) !== bytesToBase64(blob)) {
      handler.showWarning(`identity_sign: private key ${path} contents do not match public`);
      return null;
    }
    if (this.sessionId === null) return null;
    return bytesToBase64(signUserauth(key, userauthSignedData(this.sessionId, user, algorithm, blob)));
  }

  private userauthTransport(conn: TcpConnection, user: string, closed: () => boolean): UserauthTransport {
    return {
      request: (method, fields, onInfoRequest) => new Promise<UserauthReply>((resolve) => {
        if (closed()) {
          resolve({ kind: 'closed' });
          return;
        }
        let settled = false;
        const finish = (reply: UserauthReply): void => {
          if (settled) return;
          settled = true;
          offData();
          offClose?.();
          resolve(reply);
        };
        const offData = conn.onData((data) => {
          let parsed: {
            op?: string; ok?: boolean; pk_ok?: boolean; methods?: string; disconnect?: string;
            name?: string; instruction?: string; prompts?: UserauthPrompt[];
          };
          try { parsed = JSON.parse(data) as typeof parsed; } catch { return; }
          if (parsed.op === 'auth_info_request') {
            const request: UserauthInfoRequest = {
              name: parsed.name ?? '', instruction: parsed.instruction ?? '', prompts: parsed.prompts ?? [],
            };
            void Promise.resolve(onInfoRequest?.(request) ?? null).then((responses) => {
              if (!settled) conn.write(JSON.stringify({ op: 'auth_info_response', responses: responses ?? [] }));
            });
            return;
          }
          if (typeof parsed.disconnect === 'string') finish({ kind: 'disconnect', reason: parsed.disconnect });
          else if (parsed.pk_ok === true) finish({ kind: 'pk_ok' });
          else if (parsed.ok === true) finish({ kind: 'success' });
          else if (parsed.ok === false) finish({ kind: 'failure', methods: parsed.methods ?? '' });
        });
        const offClose = conn.onClose?.(() => finish({ kind: 'closed' }));
        conn.write(JSON.stringify({ op: 'auth', method, user, ...fields }));
      }),
    };
  }
}

function userauthFailureLines(
  outcome: Exclude<UserauthOutcome, { kind: 'success' }>, user: string, host: string, port: number,
): string {
  if (outcome.kind === 'denied') return `${user}@${host}: Permission denied (${outcome.methods}).`;
  if (outcome.kind === 'closed') return `Connection closed by ${host} port ${port}`;
  return receivedDisconnectLines(host, port, outcome.reason);
}

export function receivedDisconnectLines(host: string, port: number, reason: string): string {
  return `Received disconnect from ${host} port ${port}:2: ${reason}\nDisconnected from ${host} port ${port}`;
}
