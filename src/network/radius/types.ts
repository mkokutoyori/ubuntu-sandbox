import { md5 } from '@/crypto/hash';
import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from '@/crypto/encoding';
import type { NetworkPdu } from '@/network/core/NetworkPdu';

export const UDP_PORT_RADIUS_AUTH = 1812;
export const UDP_PORT_RADIUS_ACCT = 1813;

export type RadiusCode =
  | 'access-request'
  | 'access-accept'
  | 'access-reject'
  | 'access-challenge'
  | 'accounting-request'
  | 'accounting-response';

export const RADIUS_CODE: Record<RadiusCode, number> = {
  'access-request': 1,
  'access-accept': 2,
  'access-reject': 3,
  'access-challenge': 11,
  'accounting-request': 4,
  'accounting-response': 5,
};

export type RadiusAttrType =
  | 'user-name'
  | 'user-password'
  | 'chap-password'
  | 'nas-ip-address'
  | 'nas-port'
  | 'service-type'
  | 'framed-protocol'
  | 'framed-ip-address'
  | 'framed-ip-netmask'
  | 'framed-mtu'
  | 'login-ip-host'
  | 'reply-message'
  | 'callback-number'
  | 'state'
  | 'class'
  | 'vendor-specific'
  | 'session-timeout'
  | 'idle-timeout'
  | 'termination-action'
  | 'called-station-id'
  | 'calling-station-id'
  | 'nas-identifier'
  | 'proxy-state'
  | 'acct-status-type'
  | 'acct-delay-time'
  | 'acct-input-octets'
  | 'acct-output-octets'
  | 'acct-session-id'
  | 'acct-authentic'
  | 'acct-session-time'
  | 'acct-input-packets'
  | 'acct-output-packets'
  | 'acct-terminate-cause'
  | 'acct-input-gigawords'
  | 'acct-output-gigawords'
  | 'event-timestamp'
  | 'chap-challenge'
  | 'nas-port-type'
  | 'tunnel-type'
  | 'tunnel-medium-type'
  | 'eap-message'
  | 'message-authenticator'
  | 'tunnel-private-group-id'
  | 'nas-port-id'
  | 'framed-pool';

export const RADIUS_ATTR: Record<RadiusAttrType, number> = {
  'user-name': 1,
  'user-password': 2,
  'chap-password': 3,
  'nas-ip-address': 4,
  'nas-port': 5,
  'service-type': 6,
  'framed-protocol': 7,
  'framed-ip-address': 8,
  'framed-ip-netmask': 9,
  'framed-mtu': 12,
  'login-ip-host': 14,
  'reply-message': 18,
  'callback-number': 19,
  'state': 24,
  'class': 25,
  'vendor-specific': 26,
  'session-timeout': 27,
  'idle-timeout': 28,
  'termination-action': 29,
  'called-station-id': 30,
  'calling-station-id': 31,
  'nas-identifier': 32,
  'proxy-state': 33,
  'acct-status-type': 40,
  'acct-delay-time': 41,
  'acct-input-octets': 42,
  'acct-output-octets': 43,
  'acct-session-id': 44,
  'acct-authentic': 45,
  'acct-session-time': 46,
  'acct-input-packets': 47,
  'acct-output-packets': 48,
  'acct-terminate-cause': 49,
  'acct-input-gigawords': 52,
  'acct-output-gigawords': 53,
  'event-timestamp': 55,
  'chap-challenge': 60,
  'nas-port-type': 61,
  'tunnel-type': 64,
  'tunnel-medium-type': 65,
  'eap-message': 79,
  'message-authenticator': 80,
  'tunnel-private-group-id': 81,
  'nas-port-id': 87,
  'framed-pool': 88,
};

export interface RadiusAttribute {
  type: RadiusAttrType;
  value: string | number;
  /** Present only on 'vendor-specific' (26): Vendor-Id + sub-attribute Vendor-Type (RFC 2865 §5.26). */
  vendor?: { id: number; type: number };
}

export interface RadiusPacket extends NetworkPdu {
  type: 'radius';
  code: RadiusCode;
  identifier: number;
  authenticator: string;
  attributes: RadiusAttribute[];
  /** Wire-format bytes, when produced by/decoded through `codec.ts` — optional, transport doesn't require it. */
  raw?: Uint8Array;
}

export interface RadiusServerConfig {
  ip: string;
  authPort: number;
  acctPort: number;
  sharedSecret: string;
  timeoutMs: number;
  retransmit: number;
}

export interface RadiusUser {
  username: string;
  password: string;
  serviceType?: number;
  replyAttributes?: RadiusAttribute[];
  /** When set, a first Access-Request is always answered Access-Challenge with this prompt before the real accept/reject (RFC 2865 §4.4). */
  challenge?: { prompt: string };
}

export interface RadiusClientConfig {
  enabled: boolean;
  servers: RadiusServerConfig[];
  nasIdentifier: string | null;
  sourceInterface: string | null;
}

export interface RadiusServerAgentConfig {
  enabled: boolean;
  port: number;
  acctPort: number;
  sharedSecret: string;
  users: Map<string, RadiusUser>;
  clients: Set<string>;
}

export function createDefaultClientConfig(): RadiusClientConfig {
  return { enabled: true, servers: [], nasIdentifier: null, sourceInterface: null };
}

export function createDefaultServerConfig(secret = 'shared'): RadiusServerAgentConfig {
  return {
    enabled: true,
    port: UDP_PORT_RADIUS_AUTH,
    acctPort: UDP_PORT_RADIUS_ACCT,
    sharedSecret: secret,
    users: new Map(),
    clients: new Set(),
  };
}

export function defaultServerEntry(ip: string, sharedSecret: string): RadiusServerConfig {
  return {
    ip, authPort: UDP_PORT_RADIUS_AUTH, acctPort: UDP_PORT_RADIUS_ACCT,
    sharedSecret, timeoutMs: 5000, retransmit: 2,
  };
}

export function attr(
  type: RadiusAttrType, value: string | number, vendor?: { id: number; type: number },
): RadiusAttribute {
  return vendor ? { type, value, vendor } : { type, value };
}

/** Find a Vendor-Specific (26) attribute by Vendor-Id + sub-attribute Vendor-Type. */
export function getVsa(pkt: RadiusPacket, vendorId: number, vendorType: number): RadiusAttribute | undefined {
  return pkt.attributes.find(
    (a) => a.type === 'vendor-specific' && a.vendor?.id === vendorId && a.vendor?.type === vendorType,
  );
}

export function getAttr(pkt: RadiusPacket, type: RadiusAttrType): RadiusAttribute | undefined {
  return pkt.attributes.find((a) => a.type === type);
}

export function encryptUserPassword(plain: string, secret: string, authenticatorHex: string): string {
  const plainBytes = utf8ToBytes(plain);
  const padded = new Uint8Array(Math.max(16, Math.ceil(plainBytes.length / 16) * 16));
  padded.set(plainBytes);
  const secretBytes = utf8ToBytes(secret);
  let prev = hexToBytes(authenticatorHex);
  const cipher = new Uint8Array(padded.length);
  for (let off = 0; off < padded.length; off += 16) {
    const padInput = new Uint8Array(secretBytes.length + prev.length);
    padInput.set(secretBytes, 0);
    padInput.set(prev, secretBytes.length);
    const pad = md5(padInput);
    const block = new Uint8Array(16);
    for (let i = 0; i < 16; i++) block[i] = padded[off + i] ^ pad[i];
    cipher.set(block, off);
    prev = block;
  }
  return bytesToHex(cipher);
}

export function decryptUserPassword(cipherHex: string, secret: string, authenticatorHex: string): string {
  const cipher = hexToBytes(cipherHex);
  const secretBytes = utf8ToBytes(secret);
  let prev = hexToBytes(authenticatorHex);
  const plain = new Uint8Array(cipher.length);
  for (let off = 0; off < cipher.length; off += 16) {
    const padInput = new Uint8Array(secretBytes.length + prev.length);
    padInput.set(secretBytes, 0);
    padInput.set(prev, secretBytes.length);
    const pad = md5(padInput);
    const block = cipher.subarray(off, off + 16);
    for (let i = 0; i < 16; i++) plain[off + i] = block[i] ^ pad[i];
    prev = block;
  }
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  return bytesToUtf8(plain.subarray(0, end));
}

export function isPrintablePassword(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}
