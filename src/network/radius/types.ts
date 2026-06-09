import { md5 } from '@/crypto/hash';
import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from '@/crypto/encoding';

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
  | 'reply-message'
  | 'state'
  | 'class'
  | 'vendor-specific'
  | 'called-station-id'
  | 'calling-station-id'
  | 'nas-identifier'
  | 'acct-status-type'
  | 'acct-session-id'
  | 'message-authenticator';

export const RADIUS_ATTR: Record<RadiusAttrType, number> = {
  'user-name': 1,
  'user-password': 2,
  'chap-password': 3,
  'nas-ip-address': 4,
  'nas-port': 5,
  'service-type': 6,
  'framed-protocol': 7,
  'reply-message': 18,
  'state': 24,
  'class': 25,
  'vendor-specific': 26,
  'called-station-id': 30,
  'calling-station-id': 31,
  'nas-identifier': 32,
  'acct-status-type': 40,
  'acct-session-id': 44,
  'message-authenticator': 80,
};

export interface RadiusAttribute {
  type: RadiusAttrType;
  value: string | number;
}

export interface RadiusPacket {
  type: 'radius';
  code: RadiusCode;
  identifier: number;
  authenticator: string;
  attributes: RadiusAttribute[];
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

export function attr(type: RadiusAttrType, value: string | number): RadiusAttribute {
  return { type, value };
}

export function getAttr(pkt: RadiusPacket, type: RadiusAttrType): RadiusAttribute | undefined {
  return pkt.attributes.find((a) => a.type === type);
}

export function makeAuthenticator(seed: number): string {
  const out: string[] = [];
  let s = seed >>> 0;
  for (let i = 0; i < 16; i++) {
    s = (s * 1103515245 + 12345 + i * 7) >>> 0;
    out.push(((s >>> 16) & 0xff).toString(16).padStart(2, '0'));
  }
  return out.join('');
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
