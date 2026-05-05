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
  readonly cwd: string;
  readonly openedAt: number;
}

export class SshServerHandler {
  private readonly dispatcher = SftpCommandDispatcher.defaults();

  constructor(
    private readonly ctx: ISshServerContext,
    private readonly eventBus: ISshServerEventBus = new SshServerEventBus(),
  ) {}

  get events(): ISshServerEventBus {
    return this.eventBus;
  }

  register(conn: TcpConnection, clientIp: string): void {
    this.eventBus.emit({
      kind: 'client_connected',
      ip: clientIp,
      timestamp: Date.now(),
    });
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

        default: {
          // Treat as SFTP command if user is authenticated.
          if (!userCtx) {
            conn.write(JSON.stringify({ ok: false, error: 'not authenticated' }));
            return;
          }
          const channelId = (parsed.channelId as number | undefined) ?? -1;
          const info = channels.get(channelId);
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
    if (user === 'root' && !this.ctx.config.permitRootLogin) {
      this.eventBus.emit({
        kind: 'auth_failure',
        user,
        reason: 'root login disabled',
        ip: clientIp,
      });
      return { ok: false };
    }
    let success = false;
    if (method === 'password') {
      success =
        this.ctx.config.passwordAuthentication &&
        this.ctx.auth.checkPassword(user, (payload.password as string) ?? '');
    } else if (method === 'publickey') {
      success =
        this.ctx.config.pubkeyAuthentication &&
        this.ctx.auth.checkPublicKey(user, (payload.publicKey as string) ?? '');
    }
    if (!success) {
      this.eventBus.emit({
        kind: 'auth_failure',
        user,
        reason: method ?? 'unknown',
        ip: clientIp,
      });
      return { ok: false };
    }
    this.eventBus.emit({
      kind: 'auth_success',
      user,
      method: method ?? 'unknown',
      ip: clientIp,
    });
    // Build a SshUserContext: in a real adapter this comes from the user manager.
    return {
      ok: true,
      userCtx: new SshUserContext(user, 1000, 1000, [], `/home/${user}`),
    };
  }
}

function errorToMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const e = error as { kind?: string; message?: string; path?: string };
    if (e.kind === 'PERMISSION_DENIED' && e.path) {
      return `Permission denied: ${e.path}`;
    }
    return e.message ?? e.kind ?? 'error';
  }
  return String(error);
}
