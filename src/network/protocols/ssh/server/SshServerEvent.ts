/**
 * SSH server event types + Observer-style event bus.
 *
 * Reference: DESIGN-SSH-SFTP.md section 8.
 */

import type { ChannelType } from '../channels/ISshChannel';

export type SshServerEvent =
  | { kind: 'client_connected'; ip: string; timestamp: number }
  | { kind: 'auth_success'; user: string; method: string; ip: string }
  | { kind: 'auth_failure'; user: string; reason: string; ip: string }
  | { kind: 'channel_opened'; user: string; channelType: ChannelType }
  | {
      kind: 'channel_closed';
      user: string;
      channelType: ChannelType;
      durationMs: number;
    }
  | { kind: 'client_disconnected'; user: string; ip: string };

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
      for (const h of list) h(event);
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
