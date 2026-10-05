/**
 * SshSession — Facade orchestrating host-key verification, authentication
 * and channel multiplexing on top of a TcpConnection.
 *
 * The state is a discriminated union; transition() replaces the value
 * rather than mutating fields, which keeps the lifecycle traceable.
 *
 * Reference: DESIGN-SSH-SFTP.md section 6.
 */

import {
  decodeUserauthBanner, decodeUserauthFailure, decodeUserauthInfoRequest, encodeUserauthInfoResponse,
  encodeUserauthRequest, type UserauthMethodRequest,
} from '../auth/UserauthMessages';
import {
  SSH_MSG_USERAUTH_BANNER, SSH_MSG_USERAUTH_FAILURE, SSH_MSG_USERAUTH_INFO_REQUEST, SSH_MSG_USERAUTH_PK_OK,
  SSH_MSG_USERAUTH_SUCCESS,
} from '../transport/SshMessageNumbers';
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
  keygenPrivateKey, sshPublicKeyBlob, sshPublicKeyFromBlob, sshKeyTypeLabel,
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
import { SshTransport, legacyFrameStream, type SshTransportFailure } from '../transport/SshTransport';
import { SSH_SERVER_IDENTIFICATION } from '../serverIdentification';

export interface SshSessionDeps {
  readonly tcpConnector: TcpConnector;
  readonly vfs: ISshLocalFs;
  readonly localUser: string;
  readonly localUid: number;
  readonly localGid: number;
  readonly knownHostsPath: string;
  readonly credentialless?: boolean;
  readonly interactionHandler: ISshInteractionHandler;
  readonly clientIdentification?: string;
}



export const SSH_PASSWORD_PROMPTS = OPENSSH_CLIENT_AUTHENTICATION.passwordPrompts;


export class SshSession implements ISshSession {
  private _state: SshSessionState = idle();
  private conn: TcpConnection | null = null;
  private sessionId: Uint8Array | null = null;

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
    const transport = new SshTransport(dialed, {
      role: 'client',
      identification: this.deps.clientIdentification ?? SSH_SERVER_IDENTIFICATION,
    });
    const established = await transport.established;
    if ('kind' in established) {
      this.transition(disconnected('key exchange failed'));
      dialed.close();
      return err({
        kind: 'KEX_FAILED', host: opts.host, port: opts.port,
        message: kexFailureMessage(established, opts.host, opts.port),
      });
    }
    this.sessionId = established.sessionId;
    const conn = legacyFrameStream(transport, dialed);
    this.conn = conn;

    const hostKey = SshHostKey.fromFiles(
      bytesToBase64(established.hostKeyBlob),
      '',
      sshPublicKeyFromBlob(established.hostKeyBlob)!.algorithm,
    );

    const verifyResult = await this.doHostKeyCheck(opts.host, hostKey, opts);
    if (!verifyResult.ok) {
      this.transition(disconnected('host key rejected'));
      conn.close();
      this.conn = null;
      return propagateErr(verifyResult);
    }

    this.transition(authenticating(opts.user, opts.host, 3));
    const authResult = await this.doAuthenticate(opts.user, transport, opts);
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
    const unread: string[] = [];
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
        for (const data of unread.splice(0)) handler(data);
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
        const data = String(parsed.data ?? '');
        if (dataHandlers.length === 0) unread.push(data);
        for (const handler of [...dataHandlers]) handler(data);
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
          `Warning: Permanently added '${host}' (${sshKeyTypeLabel(key.algorithm)}) to the list of known hosts.`,
        );
        return ok(undefined);

      case 'prompt': {
        this.transition(verifyingHostKey(host, decision.fingerprint));
        const reply =
          await this.deps.interactionHandler.promptHostKeyConfirmation(
            host,
            decision.fingerprint,
            sshKeyTypeLabel(key.algorithm),
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
    transport: SshTransport,
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
    const offClosed = transport.onClose(() => { closed = true; });
    const outcome = await runUserauth(this.userauthTransport(transport, user, () => closed), {
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

  private userauthTransport(transport: SshTransport, user: string, closed: () => boolean): UserauthTransport {
    const handler = this.deps.interactionHandler;
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
          offMessage();
          offClose();
          resolve(reply);
        };
        const offMessage = transport.onMessage((payload) => {
          const type = payload[0];
          if (type === SSH_MSG_USERAUTH_BANNER) {
            const text = decodeUserauthBanner(payload);
            if (text) handler.showInfo(text.replace(/\r?\n$/, ''));
          } else if (type === SSH_MSG_USERAUTH_SUCCESS) {
            finish({ kind: 'success' });
          } else if (type === SSH_MSG_USERAUTH_FAILURE) {
            finish({ kind: 'failure', methods: decodeUserauthFailure(payload)?.methods ?? '' });
          } else if (type === SSH_MSG_USERAUTH_PK_OK && method === 'publickey') {
            finish({ kind: 'pk_ok' });
          } else if (type === SSH_MSG_USERAUTH_INFO_REQUEST && method === 'keyboard-interactive') {
            const request = decodeUserauthInfoRequest(payload);
            if (request === null) return;
            void Promise.resolve(onInfoRequest?.(request) ?? null).then((responses) => {
              if (!settled) transport.send(encodeUserauthInfoResponse(responses ?? []));
            });
          }
        });
        const offClose = transport.onClose(() => {
          const received = transport.peerDisconnect;
          finish(received ? { kind: 'disconnect', reason: received.description } : { kind: 'closed' });
        });
        transport.send(encodeUserauthRequest(user, userauthMethodRequest(method, fields)));
      }),
    };
  }
}

function userauthMethodRequest(method: string, fields: Readonly<Record<string, unknown>>): UserauthMethodRequest {
  if (method === 'password') return { method, password: String(fields.password ?? '') };
  if (method === 'keyboard-interactive') return { method, submethods: String(fields.devices ?? '') };
  if (method === 'publickey') {
    return {
      method,
      algorithm: String(fields.algorithm ?? ''),
      publicKeyBlob: base64ToBytes(String(fields.publicKey ?? '')),
      ...(typeof fields.signature === 'string' ? { signature: base64ToBytes(fields.signature) } : {}),
    };
  }
  return { method };
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

function kexFailureMessage(failure: SshTransportFailure, host: string, port: number): string {
  if (failure.kind === 'negotiation') return `Unable to negotiate with ${host} port ${port}: ${failure.message}`;
  if (failure.kind === 'disconnect') {
    return `Received disconnect from ${host} port ${port}:${failure.disconnect?.reason ?? 0}: ${failure.message}\n`
      + `Disconnected from ${host} port ${port}`;
  }
  if (failure.kind === 'closed') {
    return failure.identified
      ? `Connection closed by ${host} port ${port}`
      : `kex_exchange_identification: Connection closed by remote host\nConnection closed by ${host} port ${port}`;
  }
  const fatal = `ssh_dispatch_run_fatal: Connection to ${host} port ${port}: ${failure.message}`;
  return failure.log ? `${failure.log}\n${fatal}` : fatal;
}
