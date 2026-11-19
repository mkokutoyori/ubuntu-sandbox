import { md5 } from '@/crypto/hash/md5';
import { sha1 } from '@/crypto/hash/sha1';
import { sha224, sha256 } from '@/crypto/hash/sha256';
import { sha384, sha512 } from '@/crypto/hash/sha512';
import { base64ToBytes, hexToBytes, utf8ToBytes } from '@/crypto/encoding';
import { verifyCrypt } from '@/crypto/passwords/verifyCrypt';
import { ntPasswordHash } from './mschapv2';

export interface KnownGoodItem {
  name: string;
  value: string;
}

export interface KnownGoodPassword {
  cleartext: string | null;
  verify(clear: string): boolean;
}

const TYPES = {
  'cleartext-password': 'clear', 'crypt-password': 'crypt', 'md5-password': 'md5', 'smd5-password': 'smd5',
  'sha-password': 'sha', 'ssha-password': 'ssha', 'nt-password': 'nt', 'sha2-password': 'sha2',
} as const;

type Kind = typeof TYPES[keyof typeof TYPES];

const HEADERS: Readonly<Record<string, Kind>> = {
  '{clear}': 'clear', '{cleartext}': 'clear', '{md5}': 'md5', '{base64_md5}': 'md5', '{smd5}': 'smd5', '{crypt}': 'crypt',
  '{sha}': 'sha', '{ssha}': 'ssha', '{md4}': 'nt', '{nt}': 'nt', '{nthash}': 'nt', '{x-nthash}': 'nt',
  '{sha2}': 'sha2', '{sha224}': 'sha2', '{sha256}': 'sha2', '{sha384}': 'sha2', '{sha512}': 'sha2',
};

const MINIMUM_LENGTH: Partial<Record<Kind, number>> = { md5: 16, smd5: 16, nt: 16, sha: 20, ssha: 20, sha2: 28 };

function normalise(value: string, minimum: number): Uint8Array {
  if (value.length % 2 === 0 && value.length >= 2 * minimum && /^[0-9a-fA-F]+$/.test(value)) return hexToBytes(value);
  if (value.length * 3 >= minimum * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    try {
      const decoded = base64ToBytes(value);
      if (decoded.length >= minimum) return decoded;
    } catch {
      return utf8ToBytes(value);
    }
  }
  return utf8ToBytes(value);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

const SHA2_BY_LENGTH: Readonly<Record<number, (input: Uint8Array) => Uint8Array>> = { 28: sha224, 32: sha256, 48: sha384, 64: sha512 };

function verifierFor(kind: Kind, value: string): (clear: string) => boolean {
  if (kind === 'clear') return (clear) => clear === value;
  if (kind === 'crypt') return (clear) => verifyCrypt(value, clear);
  const known = normalise(value, MINIMUM_LENGTH[kind] ?? 0);
  switch (kind) {
    case 'md5': return (clear) => known.length === 16 && equal(md5(utf8ToBytes(clear)), known);
    case 'smd5': return (clear) => known.length > 16 && equal(md5(concat(utf8ToBytes(clear), known.subarray(16))), known.subarray(0, 16));
    case 'sha': return (clear) => known.length === 20 && equal(sha1(utf8ToBytes(clear)), known);
    case 'ssha': return (clear) => known.length > 20 && equal(sha1(concat(utf8ToBytes(clear), known.subarray(20))), known.subarray(0, 20));
    case 'nt': return (clear) => known.length === 16 && equal(ntPasswordHash(clear), known);
    default: {
      const digest = SHA2_BY_LENGTH[known.length];
      return (clear) => digest !== undefined && equal(digest(utf8ToBytes(clear)), known);
    }
  }
}

export function isKnownGoodName(name: string): boolean {
  return name.toLowerCase() in TYPES || name.toLowerCase() === 'password-with-header';
}

export function knownGoodPassword(items: readonly KnownGoodItem[]): KnownGoodPassword | null {
  for (const item of items) {
    const key = item.name.toLowerCase();
    if (key === 'password-with-header') {
      const header = /^\{[^}]*\}/.exec(item.value)?.[0].toLowerCase();
      const kind = header === undefined ? undefined : HEADERS[header];
      if (header === undefined || kind === undefined) return { cleartext: item.value, verify: (clear) => clear === item.value };
      const rest = item.value.slice(header.length);
      return { cleartext: kind === 'clear' ? rest : null, verify: verifierFor(kind, rest) };
    }
    const kind = TYPES[key as keyof typeof TYPES];
    if (kind !== undefined) return { cleartext: kind === 'clear' ? item.value : null, verify: verifierFor(kind, item.value) };
  }
  return null;
}
