/**
 * SshServerHandler — server-side endpoint registered on TCP port 22.
 *
 * Orchestrates the protocol negotiation, authentication and channel dispatch.
 * Depends only on ISshServerContext (Linux/Windows adapters provide it).
 *
 * Reference: DESIGN-SSH-SFTP.md section 8.
 */

import type { TcpConnection } from '@/network/core/TcpConnection';
import type { ChannelType } from '../channels/ISshChannel';
import { isErr, isOk } from '../Result';
import { PermissionCheckingFSDecorator } from '../sftp/PermissionCheckingFSDecorator';
import { SftpCommandDispatcher } from '../sftp/SftpCommandDispatcher';
import type { SftpRequestPayload } from '../sftp/ISftpCommand';
import { SshUserContext } from '../SshUserContext';
import type { ISshServerContext } from './ISshServerContext';
import {
  type ISshServerEventBus,
  SshServerEventBus,
} from './SshServerEvent';

interface ProtocolInfo {
  readonly clientVersion: string;
}

interface OpenChannelInfo {
  readonly type: ChannelType;
  readonly userCtx: SshUserContext;
  cwd: string;
  readonly openedAt: number;
}

export class SshServerHandler {
  private readonly dispatcher = SftpCommandDispatcher.defaults();

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
    this.eventBus.emit({
      kind: 'client_connected',
      ip: clientIp,
      timestamp: Date.now(),
    });
    // Reactive guard: throttled IPs are dropped at connect time. The bus
    // already carries the auth_throttled event, so the logger has written
    // an entry; here we just refuse the handshake.
    if (this.ctx.isClientBlocked?.(clientIp)) {
      conn.write(
        JSON.stringify({ op: 'disconnect', reason: 'throttled' }),
      );
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

  private handleConnection(conn: TcpConnection, clientIp: string): void {
    const channels = new Map<number, OpenChannelInfo>();
    let userCtx: SshUserContext | null = null;

    conn.onData((data) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      const op = parsed.op as string | undefined;
      if (!op) return;

      switch (op) {
        case 'hello': {
          const protocolInfo = this.negotiateProtocol(parsed);
          conn.write(
            JSON.stringify({
              hostKey: {
                algorithm: this.ctx.hostKey.algorithm,
                publicKey: this.ctx.hostKey.publicKey,
              },
              serverVersion: 'SSH-2.0-Sandbox-Server',
              clientVersion: protocolInfo.clientVersion,
            }),
          );
          break;
        }

        case 'auth': {
          const result = this.handleAuth(parsed, clientIp);
          conn.write(JSON.stringify({ ok: result.ok }));
          if (result.ok) {
            userCtx = result.userCtx;
            this.ctx.recordLogin(result.userCtx.username, clientIp);
          }
          break;
        }

        case 'open_channel': {
          if (!userCtx) {
            conn.write(JSON.stringify({ ok: false, error: 'not authenticated' }));
            return;
          }
          const channelType = parsed.channelType as ChannelType;
          const channelId = parsed.channelId as number;
          channels.set(channelId, {
            type: channelType,
            userCtx,
            cwd: userCtx.homeDirectory,
            openedAt: Date.now(),
          });
          this.eventBus.emit({
            kind: 'channel_opened',
            user: userCtx.username,
            channelType,
          });
          conn.write(JSON.stringify({ ok: true, channelId }));
          break;
        }

        case 'close_channel': {
          const channelId = parsed.channelId as number;
          const info = channels.get(channelId);
          if (info && userCtx) {
            this.eventBus.emit({
              kind: 'channel_closed',
              user: userCtx.username,
              channelType: info.type,
              durationMs: Date.now() - info.openedAt,
            });
          }
          channels.delete(channelId);
          break;
        }

        case 'exec': {
          // BRD SSH-05: non-interactive command execution. Also used by the
          // interactive shell sub-shell, which routes one exec per line.
          if (!userCtx) {
            conn.write(
              JSON.stringify({
                stdout: '',
                stderr: 'not authenticated',
                exitCode: 255,
              }),
            );
            return;
          }
          const command = (parsed.command as string | undefined) ?? '';
          const channelId = parsed.channelId as number | undefined;
          const cwd =
            (channelId !== undefined && channels.get(channelId)?.cwd) ||
            userCtx.homeDirectory;
          const shell = this.ctx.getShell(userCtx, cwd);
          // Real sshd treats every exec as a session: emit open/close so the
          // syslogger produces `session opened`/`session closed` lines.
          const sessionStart = Date.now();
          this.eventBus.emit({
            kind: 'channel_opened',
            user: userCtx.username,
            channelType: 'exec',
          });
          const userForClose = userCtx;
          void shell.execute(command).then((result) => {
            conn.write(JSON.stringify(result));
            this.eventBus.emit({
              kind: 'channel_closed',
              user: userForClose.username,
              channelType: 'exec',
              durationMs: Date.now() - sessionStart,
            });
          });
          break;
        }

        case 'shell_open': {
          // Analysis doc §5 P4 — allocate a persistent shell session.
          if (!userCtx) {
            conn.write(JSON.stringify({ ok: false, error: 'not authenticated' }));
            return;
          }
          const channelId = parsed.channelId as number;
          const cwd =
            channels.get(channelId)?.cwd ?? userCtx.homeDirectory;
          channels.set(channelId, {
            type: 'shell',
            userCtx,
            cwd,
            openedAt: Date.now(),
          });
          this.eventBus.emit({
            kind: 'channel_opened',
            user: userCtx.username,
            channelType: 'shell',
          });
          conn.write(JSON.stringify({ ok: true, channelId }));
          break;
        }

        case 'shell_input': {
          if (!userCtx) {
            conn.write(
              JSON.stringify({
                stdout: '',
                stderr: 'not authenticated',
                exitCode: 255,
              }),
            );
            return;
          }
          const channelId = parsed.channelId as number;
          const info = channels.get(channelId);
          const cwd = info?.cwd ?? userCtx.homeDirectory;
          const line = (parsed.data as string | undefined) ?? '';
          const shell = this.ctx.getShell(userCtx, cwd);
          void shell.execute(line).then((result) => {
            conn.write(JSON.stringify(result));
          });
          break;
        }

        case 'shell_close': {
          const channelId = parsed.channelId as number;
          const info = channels.get(channelId);
          if (info && userCtx) {
            this.eventBus.emit({
              kind: 'channel_closed',
              user: userCtx.username,
              channelType: info.type,
              durationMs: Date.now() - info.openedAt,
            });
            // Pair with the recordLogin fired in `auth` — once the last
            // channel closes the session is over from the user's point
            // of view, so record the logout. Linux uses this to append
            // wtmp; Windows turns it into a 4634 (Logoff) Security event.
            this.ctx.recordLogout?.(userCtx.username, clientIp);
          }
          channels.delete(channelId);
          conn.write(JSON.stringify({ ok: true, channelId }));
          break;
        }

        case 'shell_resize': {
          // Cosmetic — we don't model a real PTY but emit a hook event
          // so subscribers (syslogger, tests) can see resize traffic.
          break;
        }

        default: {
          // Treat as SFTP command if user is authenticated.
          if (!userCtx) {
            conn.write(JSON.stringify({ ok: false, error: 'not authenticated' }));
            return;
          }
          const channelId = (parsed.channelId as number | undefined) ?? -1;
          let info = channels.get(channelId);
          if (!info && channelId >= 0) {
            info = { type: 'sftp', userCtx, cwd: userCtx.homeDirectory, openedAt: Date.now() };
            channels.set(channelId, info);
          }
          const cwd = info?.cwd ?? userCtx.homeDirectory;
          const fs = new PermissionCheckingFSDecorator(
            this.ctx.getFilesystem(userCtx),
            userCtx,
          );
          const result = this.dispatcher.dispatch(
            op,
            parsed as unknown as SftpRequestPayload,
            { vfs: fs, userCtx, cwd },
          );
          if (isOk(result)) {
            const payload = (result.value as object) ?? {};
            const newCwd = (payload as { cwd?: unknown }).cwd;
            if (info && typeof newCwd === 'string') info.cwd = newCwd;
            conn.write(JSON.stringify({ ok: true, ...payload }));
          } else if (isErr(result)) {
            conn.write(
              JSON.stringify({ ok: false, error: errorToMessage(result.error) }),
            );
          }
        }
      }
    });
  }

  private negotiateProtocol(payload: Record<string, unknown>): ProtocolInfo {
    return {
      clientVersion:
        (payload.clientVersion as string | undefined) ?? 'SSH-2.0-Unknown',
    };
  }

  private handleAuth(
    payload: Record<string, unknown>,
    clientIp: string,
  ):
    | { ok: false }
    | { ok: true; userCtx: SshUserContext } {
    const method = payload.method as string | undefined;
    const user = (payload.user as string | undefined) ?? '';
    const password = (payload.password as string | undefined) ?? '';

    // Reactive throttler check: refuse before consulting auth.
    if (this.ctx.isClientBlocked?.(clientIp)) {
      this.eventBus.emit({
        kind: 'auth_failure',
        user,
        reason: 'throttled',
        ip: clientIp,
        method,
      });
      return { ok: false };
    }

    // Root-login policy is a separate reason from a generic auth failure.
    if (user === 'root' && !this.ctx.config.permitRootLogin) {
      this.eventBus.emit({
        kind: 'auth_failure',
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
      this.eventBus.emit({
        kind: 'auth_invalid_user',
        user,
        ip: clientIp,
        timestamp: Date.now(),
      });
      // We still consult the auth context so the throttler counts the
      // failure and the response timing matches a real bad password attempt.
      // (Real sshd does the same for the same reason: side-channel hardening.)
      this.eventBus.emit({
        kind: 'auth_failure',
        user,
        reason: 'invalid_user',
        ip: clientIp,
        method,
      });
      return { ok: false };
    }

    // PermitEmptyPasswords gate (cheaper than calling the user DB).
    if (
      method === 'password' &&
      password.length === 0 &&
      this.ctx.permitEmptyPasswords?.() === false
    ) {
      this.eventBus.emit({
        kind: 'auth_failure',
        user,
        reason: 'empty_password_disabled',
        ip: clientIp,
        method,
      });
      return { ok: false };
    }

    let success = false;
    if (method === 'password') {
      success =
        this.ctx.config.passwordAuthentication &&
        this.ctx.auth.checkPassword(user, password);
    } else if (method === 'publickey') {
      success =
        this.ctx.config.pubkeyAuthentication &&
        this.ctx.auth.checkPublicKey(user, (payload.publicKey as string) ?? '');
    }
    if (!success) {
      this.eventBus.emit({
        kind: 'auth_failure',
        user,
        reason: method === 'password' ? 'wrong_password' : 'wrong_key',
        ip: clientIp,
        method,
      });
      this.ctx.recordAuthFailure?.(user, clientIp, method ?? 'unknown');
      return { ok: false };
    }
    this.eventBus.emit({
      kind: 'auth_success',
      user,
      method: method ?? 'unknown',
      ip: clientIp,
      timestamp: Date.now(),
    });
    const userCtx =
      this.ctx.buildUserContext(user) ??
      new SshUserContext(user, 1000, 1000, [], `/home/${user}`);
    return { ok: true, userCtx };
  }
}

/**
 * BRD SFTP-07: normalise underlying errors into OpenSSH-style short
 * messages. The client (`SftpSession`) wraps those into the full
 * "Couldn't … : <msg>" / "remote open(\"<path>\"): <msg>" sentences.
 */
function errorToMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const e = error as { kind?: string; message?: string; path?: string };

  if (e.kind === 'PERMISSION_DENIED') return 'Permission denied';
  if (e.kind === 'NOT_AUTHENTICATED') return 'not authenticated';
  if (e.kind === 'INVALID_ARGUMENT') return e.message ?? 'invalid argument';
  if (e.kind === 'UNKNOWN_OP') return 'Unknown SFTP op';

  if (e.kind === 'IO_ERROR') {
    const msg = (e.message ?? '').toLowerCase();
    if (msg.includes('no such') || msg.includes('not found') || msg.includes('cannot read')) {
      return 'No such file or directory';
    }
    if (msg.includes('parent') && msg.includes('does not exist')) {
      return 'No such file or directory';
    }
    if (msg.includes('is a directory') || msg.includes('not a directory')) {
      return 'Failure';
    }
    if (msg.includes('already exists') || msg.includes('file exists')) {
      return 'File exists';
    }
    if (msg.includes('write failed') || msg.includes('permission')) {
      return 'Permission denied';
    }
    if (msg.includes('rmdir failed') || msg.includes('rm failed')) {
      return 'Failure';
    }
    if (msg.includes('rename')) return 'Failure';
    return e.message ?? 'Failure';
  }

  return e.message ?? e.kind ?? 'error';
}
