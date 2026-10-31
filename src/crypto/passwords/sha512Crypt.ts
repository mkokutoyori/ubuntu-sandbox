import { sha256, sha512 } from '../hash';
import { utf8ToBytes } from '../encoding';
import { systemRandom, type RandomSource } from '../random';

const MAX_SALT_LENGTH = 16;
const DEFAULT_ROUNDS = 5000;
const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

interface ShaCryptVariant {
  readonly magic: string;
  readonly digest: (data: Uint8Array) => Uint8Array;
  readonly digestLength: number;
  readonly triples: ReadonlyArray<readonly [number, number, number]>;
  readonly tail: { readonly middle: number | null; readonly low: number; readonly count: number };
  readonly checksumLength: number;
}

const SHA512_VARIANT: ShaCryptVariant = {
  magic: '$6$',
  digest: sha512,
  digestLength: 64,
  triples: [
    [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48], [28, 49, 7],
    [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13], [56, 14, 35], [15, 36, 57],
    [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41],
  ],
  tail: { middle: null, low: 63, count: 2 },
  checksumLength: 86,
};

const SHA256_VARIANT: ShaCryptVariant = {
  magic: '$5$',
  digest: sha256,
  digestLength: 32,
  triples: [[0, 10, 20], [21, 1, 11], [12, 22, 2], [3, 13, 23], [24, 4, 14], [15, 25, 5], [6, 16, 26], [27, 7, 17], [18, 28, 8], [9, 19, 29]],
  tail: { middle: 31, low: 30, count: 3 },
  checksumLength: 43,
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function repeated(block: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let at = 0; at < length; at++) out[at] = block[at % block.length];
  return out;
}

function encode24(high: number, middle: number, low: number, count: number): string {
  let word = (high << 16) | (middle << 8) | low;
  let out = '';
  for (let step = 0; step < count; step++) {
    out += ITOA64[word & 0x3f];
    word >>>= 6;
  }
  return out;
}

export interface ShaCryptParts {
  readonly salt: string;
  readonly rounds: number | null;
  readonly checksum: string;
}

function parseShaCrypt(variant: ShaCryptVariant, secret: string): ShaCryptParts | null {
  const magic = variant.magic.replace(/\$/g, '\\$');
  const match = new RegExp(`^${magic}(?:rounds=(\\d+)\\$)?([^$]{0,16})\\$([./0-9A-Za-z]{${variant.checksumLength}})$`).exec(secret);
  return match === null ? null : { salt: match[2], rounds: match[1] === undefined ? null : Number(match[1]), checksum: match[3] };
}

const COMPUTED = new Map<string, string>();
const COMPUTED_LIMIT = 256;

function shaCrypt(variant: ShaCryptVariant, password: string, salt: string, rounds: number | null): string {
  const memoKey = `${variant.magic}\0${salt}\0${rounds}\0${password}`;
  const known = COMPUTED.get(memoKey);
  if (known !== undefined) return known;
  const result = computeShaCrypt(variant, password, salt, rounds);
  if (COMPUTED.size >= COMPUTED_LIMIT) COMPUTED.delete(COMPUTED.keys().next().value as string);
  COMPUTED.set(memoKey, result);
  return result;
}

function computeShaCrypt(variant: ShaCryptVariant, password: string, salt: string, rounds: number | null): string {
  const hash = variant.digest;
  const effectiveRounds = rounds === null ? DEFAULT_ROUNDS : Math.min(999999999, Math.max(1000, rounds));
  const saltText = salt.slice(0, MAX_SALT_LENGTH);
  const key = utf8ToBytes(password);
  const saltBytes = utf8ToBytes(saltText);
  const alternate = hash(concat(key, saltBytes, key));
  const initial: Uint8Array[] = [key, saltBytes];
  let remaining = key.length;
  for (; remaining > variant.digestLength; remaining -= variant.digestLength) initial.push(alternate);
  initial.push(alternate.subarray(0, remaining));
  for (let bits = key.length; bits > 0; bits >>= 1) initial.push((bits & 1) === 1 ? alternate : key);
  let digest = hash(concat(...initial));
  const keyDigest = hash(repeated(key, key.length * key.length));
  const keyBytes = repeated(keyDigest, key.length);
  const saltDigest = hash(repeated(saltBytes, saltBytes.length * (16 + digest[0])));
  const saltSequence = repeated(saltDigest, saltBytes.length);
  for (let round = 0; round < effectiveRounds; round++) {
    const parts: Uint8Array[] = [(round & 1) === 1 ? keyBytes : digest];
    if (round % 3 !== 0) parts.push(saltSequence);
    if (round % 7 !== 0) parts.push(keyBytes);
    parts.push((round & 1) === 1 ? digest : keyBytes);
    digest = hash(concat(...parts));
  }
  let checksum = '';
  for (const [high, middle, low] of variant.triples) checksum += encode24(digest[high], digest[middle], digest[low], 4);
  const tail = variant.tail;
  checksum += encode24(0, tail.middle === null ? 0 : digest[tail.middle], digest[tail.low], tail.count);
  const prefix = rounds === null ? variant.magic : `${variant.magic}rounds=${effectiveRounds}$`;
  return `${prefix}${saltText}$${checksum}`;
}

export const parseSha512Crypt = (secret: string): ShaCryptParts | null => parseShaCrypt(SHA512_VARIANT, secret);
export const parseSha256Crypt = (secret: string): ShaCryptParts | null => parseShaCrypt(SHA256_VARIANT, secret);
export const sha512Crypt = (password: string, salt: string, rounds: number | null = null): string => shaCrypt(SHA512_VARIANT, password, salt, rounds);
export const sha256Crypt = (password: string, salt: string, rounds: number | null = null): string => shaCrypt(SHA256_VARIANT, password, salt, rounds);

const VERIFIED = new Map<string, boolean>();
const VERIFIED_LIMIT = 512;

export function verifySha512Crypt(secret: string, password: string): boolean {
  return verifyShaCrypt(secret, password, parseSha512Crypt, sha512Crypt);
}

export function verifySha256Crypt(secret: string, password: string): boolean {
  return verifyShaCrypt(secret, password, parseSha256Crypt, sha256Crypt);
}

function verifyShaCrypt(
  secret: string,
  password: string,
  parse: (secret: string) => ShaCryptParts | null,
  compute: (password: string, salt: string, rounds: number | null) => string,
): boolean {
  const memoKey = `${secret}\0${password}`;
  const known = VERIFIED.get(memoKey);
  if (known !== undefined) return known;
  const parts = parse(secret);
  const result = parts !== null && compute(password, parts.salt, parts.rounds) === secret;
  if (VERIFIED.size >= VERIFIED_LIMIT) VERIFIED.delete(VERIFIED.keys().next().value as string);
  VERIFIED.set(memoKey, result);
  return result;
}

export function newSha512Salt(random: RandomSource = systemRandom): string {
  return Array.from(random(MAX_SALT_LENGTH), (byte) => ITOA64[byte & 0x3f]).join('');
}

export function hashPassword(password: string, random: RandomSource = systemRandom): string {
  return sha512Crypt(password, newSha512Salt(random));
}
