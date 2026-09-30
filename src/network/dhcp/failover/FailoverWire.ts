import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import { hmacHex } from '@/crypto/mac';
import { SHA256 } from '@/crypto/hash';
import { DHCP_FAILOVER_PORT } from '@/network/core/WellKnownPorts';

export type FailoverMessageType =
  'SETUP' | 'UPDATE' | 'SCOPESYNC' | 'REMOVE' | 'CONTACT' | 'BNDUPD' | 'SYNC';

export interface FailoverMessage {
  readonly type: FailoverMessageType;
  readonly relationship: string;
  readonly from: string;
  readonly body: Record<string, unknown>;
  readonly apReq?: string;
  readonly mac?: string;
}

export type FailoverReply = { ok: boolean; message?: string } & Record<string, unknown>;

function canonical(message: FailoverMessage): string {
  return JSON.stringify({
    type: message.type, relationship: message.relationship, from: message.from, body: message.body, apReq: message.apReq ?? null,
  });
}

export function signMessage(message: Omit<FailoverMessage, 'mac'>, secret: string | null): FailoverMessage {
  return secret === null ? message : { ...message, mac: hmacHex(SHA256, secret, canonical(message)) };
}

export function verifyMessage(message: FailoverMessage, secret: string | null): boolean {
  if (secret === null) return true;
  return message.mac !== undefined && message.mac === hmacHex(SHA256, secret, canonical(message));
}

export function decodeMessage(text: string): FailoverMessage | null {
  try {
    const parsed = JSON.parse(text) as Partial<FailoverMessage>;
    if (typeof parsed.type !== 'string' || typeof parsed.relationship !== 'string' || typeof parsed.from !== 'string') return null;
    return { type: parsed.type, relationship: parsed.relationship, from: parsed.from, body: parsed.body ?? {}, apReq: parsed.apReq ?? undefined, mac: parsed.mac };
  } catch {
    return null;
  }
}

export function sendFailoverMessage(tcp: TcpStack, address: string, message: FailoverMessage): FailoverReply | null {
  const socket: TcpSocket | null = tcp.connect(address, DHCP_FAILOVER_PORT);
  if (!socket || socket.state !== 'established') return null;
  let reply: FailoverReply | null = null;
  const unsubscribe = socket.onData((data) => {
    try { reply = JSON.parse(String(data)) as FailoverReply; } catch { reply = null; }
  });
  socket.write(JSON.stringify(message));
  unsubscribe();
  socket.close();
  return reply;
}
