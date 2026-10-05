/**
 * SshServerHandler — server-side endpoint registered on TCP port 22.
 *
 * Orchestrates the protocol negotiation, authentication and channel dispatch.
 * Depends only on ISshServerContext (Linux/Windows adapters provide it).
 *
 * Reference: DESIGN-SSH-SFTP.md section 8.
 */

import {
  USERAUTH_SUCCESS, decodeUserauthInfoResponse, decodeUserauthRequest, encodeUserauthBanner,
  encodeUserauthFailure, encodeUserauthInfoRequest, encodeUserauthPkOk, type UserauthRequest,
} from '../auth/UserauthMessages';
import {
  SSH_DISCONNECT_PROTOCOL_ERROR, SSH_MSG_USERAUTH_INFO_RESPONSE, SSH_MSG_USERAUTH_REQUEST,
} from '../transport/SshMessageNumbers';
import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import { TimerSet } from '@/events/TimerSet';
import { getDefaultScheduler } from '@/events/Scheduler';
import type { AccountLifecycleVerdict, KeyboardInteractiveChallenge } from '../auth/ISshAuthMethod';
import { PermissionCheckingFSDecorator } from '../sftp/PermissionCheckingFSDecorator';
import { SftpWireSession } from '../sftp/SftpWireSession';
import { ScpServerSession, parseScpServerCommand, type ScpServerCommand } from '../scp/ScpServerSession';
import { encodeSftpWirePacket, decodeSftpWirePacket } from '../sftp/SftpWireCodec';
import { SshUserContext } from '../SshUserContext';
import { SSH_SERVER_IDENTIFICATION } from '../serverIdentification';
import { SshConnection, type ConnectionChannel } from '../connection/SshConnection';
import { channelAsStream, pipeChannelToStream } from '../connection/ChannelStream';
import { joinWhenReady } from '../forwardRelay';
import {
  decodeDirectTcpip, decodeEnvRequest, decodePtyRequest, decodeStringPayload, decodeTcpipForward, encodeBoundPort,
  encodeExitStatus, encodeForwardedTcpip, type PtyRequestPayload,
} from '../connection/ChannelPayloads';
import { SSH_EXTENDED_DATA_STDERR, SSH_OPEN_ADMINISTRATIVELY_PROHIBITED, SSH_OPEN_CONNECT_FAILED } from '../transport/SshMessageNumbers';
import { signatureAlgorithmsFor, userauthSignedData, verifyUserauthSignature } from '../auth/UserauthSignature';
import {
  keygenBlobDigest, keygenKeyFacts, keygenPrivateKey, sshPublicKeyFromBlob,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { base64ToBytes, bytesToBase64 } from '@/crypto/encoding';
import {
  SshTransport, transportLink, type SshServerHostKey, type SshTransportConfig,
} from '../transport/SshTransport';
import type { SshHostKey } from '../SshHostKey';
import type { ISshServerContext, SshTransportPolicy } from './ISshServerContext';
import type { AuthorizedKeyOptions } from '../SshPureUtils';
import { SshShellSession } from './SshShellSession';
import {
  type ISshServerEventBus,
  SshServerEventBus,
} from './SshServerEvent';

interface SessionChannelInfo {
  started: boolean;
  shellSession: SshShellSession | null;
  pty: PtyRequestPayload | null;
  readonly environment: Map<string, string>;
}

const PREAUTH_COUNT = new WeakMap<object, { value: number }>();

function preauthSlot(ctx: object): { value: number } {
  let s = PREAUTH_COUNT.get(ctx);
  if (!s) { s = { value: 0 }; PREAUTH_COUNT.set(ctx, s); }
  return s;
}

export class SshServerHandler {

  private readonly eventBus: ISshServerEventBus;

  constructor(
    private readonly ctx: ISshServerContext,
    eventBus?: ISshServerEventBus,
  ) {
    // Prefer the bus the context owns (so reactive subscribers attached to
    // the context — logger, throttler — see every event). Fall back to the
    // explicit bus, or allocate a fresh one for self-contained tests.
    this.eventBus = eventBus ?? ctx.events ?? new SshServerEventBus();
  }

  get events(): ISshServerEventBus {
    return this.eventBus;
  }

  register(conn: TcpConnection, clientIp: string): void {
    conn.setNoDelay?.(true);
    const ms = this.ctx.config.maxStartups;
    if (ms && ms.start > 0) {
      const slot = preauthSlot(this.ctx);
      const n = slot.value;
      let refuse = false;
      if (n >= ms.full) refuse = true;
      else if (n >= ms.start) {
        const p = ms.rate / 100;
        refuse = Math.random() < p;
      }
      if (refuse) {
        conn.close();
        this.eventBus.emit({
          kind: 'client_disconnected',
          user: '', ip: clientIp,
          reason: 'too_many_failures',
          timestamp: Date.now(),
        });
        return;
      }
    }
    this.eventBus.emit({
      kind: 'client_connected',
      ip: clientIp,
      timestamp: Date.now(),
    });
    // Reactive guard: throttled IPs are dropped at connect time. The bus
    // already carries the auth_throttled event, so the logger has written
    // an entry; here we just refuse the handshake.
    if (this.ctx.isClientBlocked?.(clientIp)) {
      conn.close();
      this.eventBus.emit({
        kind: 'client_disconnected',
        user: '',
        ip: clientIp,
        reason: 'throttled',
        timestamp: Date.now(),
      });
      return;
    }
    this.handleConnection(conn, clientIp);
  }

  private serveScp(channel: ConnectionChannel, user: SshUserContext, command: ScpServerCommand): void {
    const fs = new PermissionCheckingFSDecorator(this.ctx.getFilesystem(user), user);
    const openedAt = Date.now();
    this.eventBus.emit({ kind: 'channel_opened', user: user.username, channelType: 'exec' });
    new ScpServerSession(channel, fs, user.homeDirectory, command, (exitCode) => {
      void channel.request('exit-status', encodeExitStatus(exitCode));
      channel.eof();
      channel.close();
      this.eventBus.emit({
        kind: 'channel_closed', user: user.username, channelType: 'exec', durationMs: Date.now() - openedAt,
      });
    }).start();
  }

  private serveSftp(channel: ConnectionChannel, user: SshUserContext): void {
    const fs = new PermissionCheckingFSDecorator(this.ctx.getFilesystem(user), user);
    const sftp = new SftpWireSession({
      vfs: fs, userCtx: user, rootPath: user.homeDirectory, accountNames: this.ctx.accountNames?.(),
    });
    const openedAt = Date.now();
    this.eventBus.emit({ kind: 'channel_opened', user: user.username, channelType: 'sftp' });
    let pending = new Uint8Array(0);
    channel.onData((bytes) => {
      const merged = new Uint8Array(pending.length + bytes.length);
      merged.set(pending);
      merged.set(bytes, pending.length);
      pending = merged;
      while (pending.length >= 4) {
        const length = ((pending[0] << 24) | (pending[1] << 16) | (pending[2] << 8) | pending[3]) >>> 0;
        if (pending.length < 4 + length) return;
        const packet = decodeSftpWirePacket(pending.subarray(0, 4 + length), sftp.version);
        pending = pending.slice(4 + length);
        if (packet !== null) {
          const reply = sftp.handle(packet);
          channel.write(encodeSftpWirePacket(reply, sftp.version));
        }
      }
    });
    channel.onEof(() => { channel.eof(); channel.close(); });
    channel.onClose(() => {
      this.eventBus.emit({
        kind: 'channel_closed', user: user.username, channelType: 'sftp', durationMs: Date.now() - openedAt,
      });
    });
  }

  private handleConnection(rawConn: TcpConnection, clientIp: string): void {
    const transport = new SshTransport(rawConn, {
      role: 'server',
      identification: this.ctx.serverIdentification?.() ?? SSH_SERVER_IDENTIFICATION,
      hostKeys: serverHostKeys(this.ctx.hostKey),
      ...transportPolicyConfig(this.ctx.transportPolicy?.()),
    });
    const conn = transportLink(transport, rawConn);
    const sessionChannels = new Map<number, SessionChannelInfo>();
    const remoteForwards = new Map<string, () => void>();
    let connection: SshConnection | null = null;
    let userCtx: SshUserContext | null = null;
    let logoutRecorded = false;
    const recordLogoutOnce = (user: string): void => {
      if (logoutRecorded) return;
      logoutRecorded = true;
      this.ctx.recordLogout?.(user, clientIp);
    };
    let authFailures = 0;
    let authRequests = 0;
    let sessionId: Uint8Array | null = null;
    void transport.established.then((outcome) => {
      if ('sessionId' in outcome) {
        sessionId = outcome.sessionId;
        this.ctx.transportEstablished?.(clientIp, outcome.algorithms);
      }
    });
    let pendingInfoResponse: ((responses: readonly string[] | null) => void) | null = null;
    const askKeyboardInteractive = (challenge: KeyboardInteractiveChallenge): Promise<readonly string[] | null> =>
      new Promise((resolve) => {
        pendingInfoResponse = resolve;
        transport.send(encodeUserauthInfoRequest(challenge));
      });
    const preauth = preauthSlot(this.ctx);
    preauth.value += 1;
    let preauthDecremented = false;
    const decPreauth = () => { if (!preauthDecremented) { preauth.value = Math.max(0, preauth.value - 1); preauthDecremented = true; } };

    const timers = new TimerSet(() => getDefaultScheduler());
    let graceTimer: symbol | null = null;
    let missedAcks = 0;
    const intervalSec = this.ctx.config.clientAliveInterval ?? 0;
    const maxMissed = this.ctx.config.clientAliveCountMax ?? 0;
    const graceSec = this.ctx.config.loginGraceTime ?? 0;
    if (graceSec > 0) {
      graceTimer = timers.setTimeout(() => {
        if (userCtx) return;
        this.eventBus.emit({
          kind: 'client_disconnected',
          user: '',
          ip: clientIp,
          reason: 'auth_grace_timeout',
          timestamp: Date.now(),
        });
        conn.close();
      }, graceSec * 1000);
    }
    if (intervalSec > 0 && maxMissed > 0) {
      timers.setInterval(() => {
        if (connection === null) return;
        missedAcks += 1;
        if (missedAcks > maxMissed) {
          this.eventBus.emit({
            kind: 'client_disconnected',
            user: userCtx?.username ?? '',
            ip: clientIp,
            reason: 'client-alive-timeout',
            timestamp: Date.now(),
          });
          conn.close();
          return;
        }
        connection?.sendGlobalRequest('keepalive@openssh.com', undefined, () => { missedAcks = 0; });
      }, intervalSec * 1000);
    }

    // `exec-timeout` on a network CLI's VTY line: the SERVER hangs an idle
    // EXEC session up, exactly as IOS does — the client only ever learns
    // of it by having its socket closed under it. Re-armed on every line,
    // so activity keeps the line alive.
    let idleTimer: ReturnType<TimerSet['setTimeout']> | null = null;
    const rearmExecIdle = (): void => {
      if (idleTimer !== null) timers.clear(idleTimer);
      idleTimer = null;
      const ms = this.ctx.execIdleTimeoutMs?.() ?? null;
      if (ms == null || ms <= 0) return;
      idleTimer = timers.setTimeout(() => {
        this.eventBus.emit({
          kind: 'client_disconnected',
          user: userCtx?.username ?? '',
          ip: clientIp,
          reason: 'exec_timeout',
          timestamp: Date.now(),
        });
        conn.close();
      }, ms);
    };

    conn.onClose((reason) => {
      pendingInfoResponse?.(null);
      pendingInfoResponse = null;
      if (userCtx) recordLogoutOnce(userCtx.username);
      timers.clearAll();
      idleTimer = null;
      decPreauth();
      sessionChannels.clear();
      for (const stop of remoteForwards.values()) stop();
      remoteForwards.clear();
      this.eventBus.emit({
        kind: 'client_disconnected',
        user: userCtx?.username ?? '',
        ip: clientIp,
        port: this.ctx.clientPort?.(clientIp),
        authenticated: userCtx !== null,
        ...(transport.peerIdentification === null ? { beforeIdentification: true } : {}),
        reason: reason === 'rst' ? 'reset' : 'closed',
        timestamp: Date.now(),
      });
      userCtx = null;
    });

    const serveConnection = (
      active: SshConnection, user: SshUserContext, keyOptions: AuthorizedKeyOptions | null,
    ): void => {
      active.onChannelOpen('direct-tcpip', (incoming) => {
        const target = decodeDirectTcpip(incoming.payload);
        if (target === null || !this.ctx.openDirectTcpip) {
          incoming.reject(SSH_OPEN_ADMINISTRATIVELY_PROHIBITED, 'open failed');
          return;
        }
        void this.ctx.openDirectTcpip({ user, clientIp, keyOptions, host: target.host, port: target.port })
          .then((outcome) => {
            if (outcome.kind === 'prohibited') {
              incoming.reject(SSH_OPEN_ADMINISTRATIVELY_PROHIBITED, 'open failed');
              return;
            }
            if (outcome.kind !== 'open') {
              incoming.reject(SSH_OPEN_CONNECT_FAILED, outcome.reason);
              return;
            }
            pipeChannelToStream(incoming.accept(), outcome.stream);
          });
      });
      active.onGlobalRequest((request) => {
        const forward = decodeTcpipForward(request.payload);
        if (request.name === 'cancel-tcpip-forward' && forward !== null) {
          const key = `${forward.address}:${forward.port}`;
          const stop = remoteForwards.get(key);
          remoteForwards.delete(key);
          stop?.();
          request.reply(stop !== undefined);
          return;
        }
        if (request.name !== 'tcpip-forward' || forward === null || !this.ctx.openRemoteForward) {
          request.reply(false);
          return;
        }
        if (remoteForwards.has(`${forward.address}:${forward.port}`)) {
          request.reply(false);
          return;
        }
        const outcome = this.ctx.openRemoteForward({
          user, clientIp, keyOptions, bindAddress: forward.address, port: forward.port,
          onConnection: (stream) => {
            const opened = active.openChannel('forwarded-tcpip', encodeForwardedTcpip({
              connectedAddress: forward.address, connectedPort: outcome.kind === 'listening' ? outcome.port : forward.port,
              originatorAddress: stream.remoteIp, originatorPort: stream.remotePort,
            })).then((channel) => channelAsStream(channel, {
              localIp: stream.localIp, localPort: stream.localPort, remoteIp: stream.remoteIp, remotePort: stream.remotePort,
            }), () => null);
            joinWhenReady(stream, opened);
          },
        });
        if (outcome.kind !== 'listening') {
          request.reply(false);
          return;
        }
        remoteForwards.set(`${forward.address}:${outcome.port}`, outcome.stop);
        request.reply(true, forward.port === 0 ? encodeBoundPort(outcome.port) : undefined);
      });
      active.onChannelOpen('session', (incoming) => {
        if (sessionChannels.size >= this.ctx.config.maxSessions) {
          this.eventBus.emit({
            kind: 'auth_failure',
            port: this.ctx.clientPort?.(clientIp),
            user: user.username,
            reason: 'max_sessions',
            ip: clientIp,
            method: 'open_channel',
          });
          incoming.reject(SSH_OPEN_ADMINISTRATIVELY_PROHIBITED, 'open failed');
          return;
        }
        const channel = incoming.accept();
        const info: SessionChannelInfo = { started: false, shellSession: null, pty: null, environment: new Map() };
        sessionChannels.set(channel.localId, info);
        channel.onClose(() => { sessionChannels.delete(channel.localId); });
        channel.onRequest((request) => {
          switch (request.name) {
            case 'env': {
              const variable = decodeEnvRequest(request.payload);
              const accepted = variable !== null && /^(LANG|LC_[A-Z_]+)$/.test(variable.name);
              if (accepted) info.environment.set(variable.name, variable.value);
              request.reply(accepted);
              return;
            }
            case 'pty-req': {
              const pty = decodePtyRequest(request.payload);
              if (pty !== null) info.pty = pty;
              request.reply(pty !== null);
              return;
            }
            case 'exec': {
              const asked = decodeStringPayload(request.payload);
              if (asked === null || info.started) {
                request.reply(false);
                return;
              }
              info.started = true;
              request.reply(true);
              const forced = this.ctx.forcedCommand?.(user, clientIp, keyOptions) ?? null;
              if (forced === 'internal-sftp') {
                channel.write('This service allows sftp connections only.\n');
                void channel.request('exit-status', encodeExitStatus(1));
                channel.eof();
                channel.close();
                return;
              }
              const scpCommand = forced === null ? parseScpServerCommand(asked) : null;
              if (scpCommand !== null) {
                this.serveScp(channel, user, scpCommand);
                return;
              }
              const command = forced === null ? asked : withOriginalCommand(forced, asked);
              const shell = this.ctx.getShell(user, user.homeDirectory);
              const sessionStart = Date.now();
              this.eventBus.emit({ kind: 'channel_opened', user: user.username, channelType: 'exec' });
              void shell.execute(command).then((result) => {
                channel.write(endedLine(result.stdout));
                channel.writeExtended(SSH_EXTENDED_DATA_STDERR, endedLine(result.stderr));
                void channel.request('exit-status', encodeExitStatus(result.exitCode));
                channel.eof();
                channel.close();
                shell.dispose?.();
                this.eventBus.emit({
                  kind: 'channel_closed',
                  user: user.username,
                  channelType: 'exec',
                  durationMs: Date.now() - sessionStart,
                });
              });
              return;
            }
            case 'subsystem': {
              const subsystem = decodeStringPayload(request.payload);
              if (info.started || subsystem !== 'sftp') {
                request.reply(false);
                return;
              }
              info.started = true;
              request.reply(true);
              this.serveSftp(channel, user);
              return;
            }
            case 'shell': {
              if (info.started) {
                request.reply(false);
                return;
              }
              info.started = true;
              request.reply(true);
              const forcedShell = this.ctx.forcedCommand?.(user, clientIp, keyOptions) ?? null;
              if (forcedShell !== null) {
                const runner = this.ctx.getShell(user, user.homeDirectory);
                const forcedLine = forcedShell === 'internal-sftp'
                  ? 'echo This service allows sftp connections only.' : forcedShell;
                void runner.execute(forcedLine).then((result) => {
                  runner.dispose?.();
                  channel.write(result.stdout);
                  void channel.request('exit-status', encodeExitStatus(result.exitCode));
                  channel.eof();
                  channel.close();
                });
                return;
              }
              const shell = this.ctx.getShell(user, user.homeDirectory, {
                interactive: true,
                clientIp,
                clientPort: 50_000 + (user.username.length * 7 % 10_000),
              });
              info.shellSession = new SshShellSession(channel, info.pty, {
                shell,
                interactive: this.ctx.createInteractiveShell?.(user) ?? null,
                motd: this.ctx.getMotd(),
                user,
                rearmIdle: rearmExecIdle,
                opened: () => this.eventBus.emit({ kind: 'channel_opened', user: user.username, channelType: 'shell' }),
                closed: (durationMs) => {
                  this.eventBus.emit({
                    kind: 'channel_closed', user: user.username, channelType: 'shell', durationMs,
                  });
                  recordLogoutOnce(user.username);
                },
              });
              info.shellSession.start();
              return;
            }
            default:
              if (info.shellSession !== null) info.shellSession.handleRequest(request);
              else request.reply(false);
          }
        });
      });
    };

    let authIdentity: { readonly user: string; readonly service: string } | null = null;
    const disconnect = this.ctx.maxAuthTriesDisconnect;
    const endAuthentication = (): void => {
      if (disconnect) transport.disconnect(SSH_DISCONNECT_PROTOCOL_ERROR, disconnect);
      else transport.close();
    };
    const reportMaxTries = (request: UserauthRequest): void => {
      this.eventBus.emit({
        kind: 'auth_failure',
        port: this.ctx.clientPort?.(clientIp),
        user: request.user,
        reason: 'max_auth_tries',
        ip: clientIp,
        method: request.method,
      });
    };
    transport.onMessage((payload) => {
      if (payload[0] === SSH_MSG_USERAUTH_INFO_RESPONSE) {
        const deliver = pendingInfoResponse;
        pendingInfoResponse = null;
        deliver?.(decodeUserauthInfoResponse(payload) ?? []);
        return;
      }
      if (payload[0] !== SSH_MSG_USERAUTH_REQUEST || userCtx) return;
      const request = decodeUserauthRequest(payload);
      if (request === null) {
        transport.disconnect(SSH_DISCONNECT_PROTOCOL_ERROR, 'Packet corrupt');
        return;
      }
      if (authIdentity === null) {
        authIdentity = { user: request.user, service: request.service };
        const banner = this.ctx.getBanner?.() ?? null;
        if (banner) transport.send(encodeUserauthBanner(banner));
      } else if (authIdentity.user !== request.user || authIdentity.service !== request.service) {
        transport.disconnect(SSH_DISCONNECT_PROTOCOL_ERROR,
          `Change of username or service not allowed: (${authIdentity.user},${authIdentity.service}) -> `
          + `(${request.user},${request.service})`);
        return;
      }
      pendingInfoResponse?.(null);
      pendingInfoResponse = null;
      const cap = this.ctx.config.maxAuthTries;
      authRequests += 1;
      const penaltyFree = authRequests === 1 && request.method === 'none';
      if (authFailures >= cap) {
        reportMaxTries(request);
        endAuthentication();
        return;
      }
      void this.handleAuth(userauthPayload(request), clientIp, askKeyboardInteractive, authRequests === 1, sessionId)
        .then((result) => {
          if (!transport.isOpen) return;
          if ('pkOk' in result && 'publicKeyBlob' in request) {
            transport.send(encodeUserauthPkOk(request.algorithm, request.publicKeyBlob));
            return;
          }
          if (result.ok) {
            userCtx = result.userCtx;
            transport.send(USERAUTH_SUCCESS);
            transport.markAuthenticated();
            connection = new SshConnection(transport);
            serveConnection(connection, result.userCtx, result.keyOptions);
            this.ctx.recordLogin(result.userCtx.username, clientIp);
            timers.clear(graceTimer);
            graceTimer = null;
            decPreauth();
            return;
          }
          if (!penaltyFree) authFailures += 1;
          if (authFailures >= cap) {
            reportMaxTries(request);
            endAuthentication();
            return;
          }
          transport.send(encodeUserauthFailure(this.ctx.auth.getAvailableMethods(), false));
        });
    });

  }

  private async handleAuth(
    payload: Record<string, unknown>,
    clientIp: string,
    askKeyboardInteractive: (challenge: KeyboardInteractiveChallenge) => Promise<readonly string[] | null>,
    firstRequest: boolean,
    sessionId: Uint8Array | null,
  ): Promise<
    | { ok: false }
    | { ok: false; pkOk: true }
    | { ok: true; userCtx: SshUserContext; keyOptions: AuthorizedKeyOptions | null }
  > {
    const user = (payload.user as string | undefined) ?? '';
    const credentialless = payload.method === 'none';
    if (credentialless && this.ctx.buildUserContext(user) !== null
      && !(this.ctx.auth.acceptsWithoutCredential?.(user) ?? false)) return { ok: false };
    let password = (payload.password as string | undefined) ?? '';
    let responses: readonly string[] | null = null;
    const challenge = payload.method === 'keyboard-interactive'
      ? this.ctx.auth.keyboardInteractive?.() ?? null
      : null;
    if (payload.method === 'keyboard-interactive') {
      if (!challenge) return { ok: false };
      responses = await askKeyboardInteractive(challenge);
      if (responses === null) return { ok: false };
      password = responses[0] ?? '';
    }
    const method = challenge ? `keyboard-interactive/${challenge.device}` : payload.method as string | undefined;
    const passwordBacked = payload.method === 'password' || challenge !== null;

    // Reactive throttler check: refuse before consulting auth.
    if (this.ctx.isClientBlocked?.(clientIp, user)) {
      this.eventBus.emit({
        kind: 'auth_failure',
        port: this.ctx.clientPort?.(clientIp),
        user,
        reason: 'throttled',
        ip: clientIp,
        method,
      });
      return { ok: false };
    }

    // Root-login policy is a separate reason from a generic auth failure.
    const rootMethod = method === 'publickey' ? 'publickey' : 'password';
    const rootAllowed = this.ctx.rootMayLogIn?.(rootMethod) ?? this.ctx.config.permitRootLogin;
    if (user === 'root' && !rootAllowed) {
      this.eventBus.emit({
        kind: 'auth_failure',
        port: this.ctx.clientPort?.(clientIp),
        user,
        reason: 'root_login_disabled',
        ip: clientIp,
        method,
      });
      this.ctx.recordAuthFailure?.(user, clientIp, 'root login disabled');
      return { ok: false };
    }

    // OpenSSH emits a distinct "Invalid user" line when the principal does
    // not exist on the system. We mirror that by checking buildUserContext
    // before any credential validation.
    const userExists = this.ctx.buildUserContext(user) !== null;
    if (!userExists) {
      if (firstRequest) {
        this.eventBus.emit({
          kind: 'auth_invalid_user',
          user,
          ip: clientIp,
          port: this.ctx.clientPort?.(clientIp),
          timestamp: Date.now(),
        });
      }
      // We still consult the auth context so the throttler counts the
      // failure and the response timing matches a real bad password attempt.
      // (Real sshd does the same for the same reason: side-channel hardening.)
      this.eventBus.emit({
        kind: 'auth_failure',
        port: this.ctx.clientPort?.(clientIp),
        user,
        reason: 'invalid_user',
        ip: clientIp,
        method,
        validUser: false,
      });
      if (!credentialless) this.ctx.recordAuthFailure?.(user, clientIp, 'invalid user');
      return { ok: false };
    }

    // PermitEmptyPasswords gate (cheaper than calling the user DB).
    if (
      passwordBacked &&
      password.length === 0 &&
      this.ctx.permitEmptyPasswords?.() === false
    ) {
      this.eventBus.emit({
        kind: 'auth_failure',
        port: this.ctx.clientPort?.(clientIp),
        user,
        reason: 'empty_password_disabled',
        ip: clientIp,
        method,
      });
      return { ok: false };
    }

    let success = false;
    let keyOptions: AuthorizedKeyOptions | null = null;
    let authenticatedKey: string | null = null;
    if (credentialless) {
      success = this.ctx.auth.acceptsWithoutCredential?.(user) ?? false;
    } else if (challenge && responses) {
      success = challenge.verify(user, responses);
    } else if (method === 'password') {
      success = this.ctx.config.passwordAuthentication && (
        this.ctx.auth.checkPasswordAsync
          ? await this.ctx.auth.checkPasswordAsync(user, password)
          : this.ctx.auth.checkPassword(user, password)
      );
    } else if (method === 'publickey') {
      const offered = (payload.publicKey as string) ?? '';
      let keyAdmitted: boolean;
      if (this.ctx.admittedKey) {
        const admitted = this.ctx.admittedKey(user, offered, { ip: clientIp });
        const rootForced = user !== 'root'
          || (this.ctx.rootMayLogIn?.('publickey', admitted?.options?.command !== undefined) ?? true);
        keyAdmitted = this.ctx.config.pubkeyAuthentication && admitted !== null && rootForced;
        keyOptions = admitted?.options ?? null;
      } else {
        keyAdmitted = this.ctx.config.pubkeyAuthentication && this.ctx.auth.checkPublicKey(user, offered);
      }
      const signature = payload.signature as string | undefined;
      if (signature === undefined && keyAdmitted) return { ok: false, pkOk: true };
      success = keyAdmitted && signature !== undefined
        && signatureProvesKey(sessionId, user, String(payload.algorithm ?? ''), offered, signature);
      authenticatedKey = offered;
    }
    if (!success) {
      this.eventBus.emit({
        kind: 'auth_failure',
        port: this.ctx.clientPort?.(clientIp),
        user,
        reason: passwordBacked ? 'wrong_password' : 'wrong_key',
        ip: clientIp,
        method,
      });
      this.ctx.recordAuthFailure?.(user, clientIp, method ?? 'unknown');
      return { ok: false };
    }

    const lifecycle: AccountLifecycleVerdict =
      this.ctx.auth.checkAccountLifecycle?.(user) ?? { ok: true };
    if (!lifecycle.ok) {
      this.eventBus.emit({
        kind: 'auth_failure',
        port: this.ctx.clientPort?.(clientIp),
        user,
        reason: lifecycle.kind === 'account-expired' ? 'account_expired' : 'password_expired',
        ip: clientIp,
        method,
      });
      if (lifecycle.kind === 'password-expired') {
        this.eventBus.emit({ kind: 'auth_account_phase', user, ip: clientIp });
      }
      this.ctx.recordAuthFailure?.(user, clientIp, lifecycle.kind);
      return { ok: false };
    }

    this.eventBus.emit({
      kind: 'auth_success',
      user,
      method: method ?? 'unknown',
      ip: clientIp,
      port: this.ctx.clientPort?.(clientIp),
      timestamp: Date.now(),
      ...(authenticatedKey === null ? {} : keyEvidence(authenticatedKey)),
    });
    const userCtx =
      this.ctx.buildUserContext(user) ??
      new SshUserContext(user, 1000, 1000, [], `/home/${user}`);
    return { ok: true, userCtx, keyOptions };
  }
}

function signatureProvesKey(
  sessionId: Uint8Array | null, user: string, algorithm: string, publicKey: string, signature: string,
): boolean {
  if (sessionId === null) return false;
  try {
    const blob = base64ToBytes(publicKey);
    const key = sshPublicKeyFromBlob(blob);
    if (key === null || !signatureAlgorithmsFor(key).includes(algorithm)) return false;
    return verifyUserauthSignature(
      blob, algorithm, base64ToBytes(signature), userauthSignedData(sessionId, user, algorithm, blob));
  } catch {
    return false;
  }
}

function keyEvidence(publicKey: string): { keyType: string; keyFingerprint: string } | Record<string, never> {
  const algorithm = (() => {
    try { return sshPublicKeyFromBlob(base64ToBytes(publicKey))?.algorithm ?? null; } catch { return null; }
  })();
  const fingerprint = keygenBlobDigest(publicKey, 'sha256');
  if (algorithm === null || fingerprint === null) return {};
  return { keyType: keygenKeyFacts(`${algorithm} ${publicKey}`).label, keyFingerprint: fingerprint };
}

function withOriginalCommand(forced: string, asked: string): string {
  if (!asked) return forced;
  return `export SSH_ORIGINAL_COMMAND='${asked.replace(/'/g, "'\\''")}'; ${forced}`;
}

function userauthPayload(request: UserauthRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = { user: request.user, method: request.method };
  if ('password' in request) payload.password = request.password;
  if ('publicKeyBlob' in request) {
    payload.algorithm = request.algorithm;
    payload.publicKey = bytesToBase64(request.publicKeyBlob);
    if (request.signature) payload.signature = bytesToBase64(request.signature);
  }
  return payload;
}

function transportPolicyConfig(policy: SshTransportPolicy | undefined): Partial<SshTransportConfig> {
  return {
    ...(policy?.algorithms === undefined ? {} : { algorithms: policy.algorithms }),
    ...(policy?.groupExchangeMinBits === undefined ? {} : { groupExchangeMinBits: policy.groupExchangeMinBits }),
    ...(policy?.extInfo === undefined ? {} : { extInfo: policy.extInfo }),
  };
}

function endedLine(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

function serverHostKeys(hostKey: SshHostKey): SshServerHostKey[] {
  const privateKey = keygenPrivateKey(hostKey.privateKeyBlob);
  if (privateKey === null) return [];
  return [{ publicKeyBlob: base64ToBytes(hostKey.publicKey), privateKey }];
}
