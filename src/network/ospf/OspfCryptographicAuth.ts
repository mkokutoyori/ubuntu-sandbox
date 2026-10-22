import { md5Hex } from '@/crypto/hash';
import type { OSPFPacketHeader } from './types';

const KEY_BYTES = 16;
const CRYPTOGRAPHIC_AUTH_TYPE = 2;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Map) return `Map${canonical([...value.entries()])}`;
  if (value instanceof Set) return `Set${canonical([...value.values()])}`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function paddedKey(secret: string): string {
  return secret.slice(0, KEY_BYTES).padEnd(KEY_BYTES, '\0');
}

export function ospfMd5Digest(packet: OSPFPacketHeader, secret: string): string {
  return md5Hex(canonical({ ...packet, authDigest: undefined }) + paddedKey(secret));
}

export function signOspfPacket<T extends OSPFPacketHeader>(packet: T, keyId: number, secret: string, sequence: number): T {
  const signed: T = { ...packet, authType: CRYPTOGRAPHIC_AUTH_TYPE, authKey: undefined, authKeyId: keyId, authSequence: sequence };
  signed.authDigest = ospfMd5Digest(signed, secret);
  return signed;
}

export function ospfDigestMatches(packet: OSPFPacketHeader, secret: string): boolean {
  return packet.authDigest !== undefined && packet.authDigest === ospfMd5Digest(packet, secret);
}
