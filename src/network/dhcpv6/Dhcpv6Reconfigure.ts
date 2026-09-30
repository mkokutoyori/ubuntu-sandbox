import { hmac } from '../../crypto/mac';
import { MD5 } from '../../crypto/hash';
import { DHCPv6Packet } from './DHCPv6Packet';
import type { DHCPv6Authentication } from './DHCPv6Packet';
import type { DHCPv6Server } from './DHCPv6Server';

const ZERO_DIGEST = '0'.repeat(32);

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from((hex.match(/../g) ?? []).map(pair => parseInt(pair, 16)));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function digestInput(message: DHCPv6Packet): Uint8Array {
  const auth = message.authentication;
  const text = [
    message.msgType, message.transactionId, message.serverDuid ?? '', message.clientDuid ?? '',
    message.reconfigureMessage ?? '', auth ? `${auth.protocol}/${auth.algorithm}/${auth.rdm}/${auth.type}` : '',
    ZERO_DIGEST,
  ].join('|');
  return new TextEncoder().encode(text);
}

export function reconfigureDigest(message: DHCPv6Packet, keyHex: string): string {
  return bytesToHex(hmac(MD5, hexToBytes(keyHex), digestInput(message)));
}

export function verifyReconfigure(message: DHCPv6Packet, keyHex: string): boolean {
  const auth: DHCPv6Authentication | null = message.authentication;
  if (!auth || auth.protocol !== 3 || auth.algorithm !== 1 || auth.rdm !== 0 || auth.type !== 2) return false;
  return reconfigureDigest(message, keyHex) === auth.value;
}

export function buildReconfigure(
  server: DHCPv6Server, clientDuid: string, msgType: 'RENEW' | 'REBIND' | 'INFORMATION-REQUEST',
): DHCPv6Packet | null {
  if (!server.isReconfigureWilling(clientDuid) || !server.hasReconfigureKey(clientDuid)) return null;
  const message = new DHCPv6Packet();
  message.msgType = 'RECONFIGURE';
  message.transactionId = 0;
  message.serverDuid = server.getServerDuid();
  message.clientDuid = clientDuid;
  message.reconfigureMessage = msgType;
  message.authentication = { protocol: 3, algorithm: 1, rdm: 0, type: 2, value: ZERO_DIGEST };
  message.authentication = { ...message.authentication, value: reconfigureDigest(message, server.reconfigureKeyFor(clientDuid)) };
  return message;
}
