/**
 * SSH server event types + Observer-style event bus.
 *
 * Reference: DESIGN-SSH-SFTP.md section 8.
 *
 * The bus is the single integration point between the SSH transport layer
 * (SshServerHandler) and reactive subscribers: SshSyslogger writes auth.log
 * lines, SshAuthThrottler implements fail2ban-style rate limiting,
 * SshSessionTracker can count concurrent sessions, etc. Adding a new
 * reactor never requires touching the handler — just subscribe.
 */

import type { ChannelType } from '../channels/ISshChannel';

/**
 * Reason an SSH connection was terminated. Maps to OpenSSH disconnect codes
 * where applicable (SSH2_DISCONNECT_*).
 */
export type DisconnectReason =
  | 'client_disconnect'
  | 'auth_failed'
  | 'auth_grace_timeout'
  | 'too_many_failures'
  | 'host_key_rejected'
  | 'protocol_error'
  | 'admin_disconnect'
  | 'throttled';

/**
 * Specific reason an auth attempt failed. Used by both the syslogger
 * (to produce OpenSSH-compatible messages) and the throttler.
 */
export type AuthFailureReason =
  | 'wrong_password'
  | 'wrong_key'
  | 'method_disabled'
  | 'root_login_disabled'
  | 'user_not_allowed'
  | 'empty_password_disabled'
  | 'invalid_user'
  | 'throttled'
  | 'unknown';

export type SshServerEvent =
  | { kind: 'client_connected'; ip: string; port?: number; timestamp: number }
  | {
      kind: 'auth_success';
      user: string;
      method: string;
      ip: string;
      port?: number;
      keyFingerprint?: string;
      timestamp?: number;
    }
  | {
      kind: 'auth_failure';
      user: string;
      reason: string;
      ip: string;
      method?: string;
      port?: number;
      timestamp?: number;
    }
  | {
      kind: 'auth_invalid_user';
      user: string;
      ip: string;
      port?: number;
      timestamp?: number;
    }
  | {
      kind: 'auth_throttled';
      ip: string;
      failuresInWindow: number;
      windowSeconds: number;
      blockUntil: number;
      timestamp?: number;
    }
  | { kind: 'channel_opened'; user: string; channelType: ChannelType }
  | {
      kind: 'channel_closed';
      user: string;
      channelType: ChannelType;
      durationMs: number;
    }
  | {
      kind: 'client_disconnected';
      user: string;
      ip: string;
      reason?: DisconnectReason;
      timestamp?: number;
    };

export interface ISshServerEventBus {
  emit(event: SshServerEvent): void;
  on(
    type: SshServerEvent['kind'] | '*',
    handler: (event: SshServerEvent) => void,
  ): () => void;
}

export class SshServerEventBus implements ISshServerEventBus {
  private handlers = new Map<string, Array<(e: SshServerEvent) => void>>();

  emit(event: SshServerEvent): void {
    for (const key of [event.kind, '*']) {
      const list = this.handlers.get(key);
      if (!list) continue;
      // Iterate over a snapshot so handlers can dispose themselves safely.
      for (const h of [...list]) h(event);
    }
  }

  on(
    type: SshServerEvent['kind'] | '*',
    handler: (event: SshServerEvent) => void,
  ): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
    return () => {
      const cur = this.handlers.get(type) ?? [];
      this.handlers.set(
        type,
        cur.filter((h) => h !== handler),
      );
    };
  }
}
