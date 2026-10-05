import { sha256 } from '@/crypto/hash/sha256';
import { md5 } from '@/crypto/hash/md5';
import { sha1 } from '@/crypto/hash/sha1';
import { sha384, sha512 } from '@/crypto/hash/sha512';
import { base64ToBytes, bytesToBase64, utf8ToBytes } from '@/crypto/encoding';
import { ed25519PublicKey } from '@/crypto/ecc/ed25519';
import { generateP256PrivateScalar, p256PublicKey, P256_FIELD_BYTES } from '@/crypto/ecc/p256';
import { bitLength, generateRsaKeyPair, modInverse, type RandomBytes } from '@/crypto/rsa/rsa';
import { SshReader, SshWriter } from '@/network/protocols/ssh/wire/SshDataTypes';

export const KEYGEN_ALGORITHMS: Readonly<Record<string, string>> = {
  ed25519: 'ssh-ed25519',
  rsa: 'ssh-rsa',
  ecdsa: 'ecdsa-sha2-nistp256',
};

const PRIVATE_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';
const PRIVATE_FOOTER = '-----END OPENSSH PRIVATE KEY-----';
const AUTH_MAGIC = 'openssh-key-v1\0';
const UNENCRYPTED_BLOCK_SIZE = 8;
const ARMOUR_LINE_LENGTH = 70;
const NISTP256 = 'nistp256';

export interface KeygenPair {
  readonly pub: string;
  readonly priv: string;
}

export type SshPrivateKey =
  | {
    readonly algorithm: 'ssh-ed25519';
    readonly seed: Uint8Array;
    readonly publicKey: Uint8Array;
    readonly comment: string;
  }
  | {
    readonly algorithm: 'ssh-rsa';
    readonly n: bigint;
    readonly e: bigint;
    readonly d: bigint;
    readonly iqmp: bigint;
    readonly p: bigint;
    readonly q: bigint;
    readonly comment: string;
  }
  | {
    readonly algorithm: 'ecdsa-sha2-nistp256';
    readonly q: Uint8Array;
    readonly d: bigint;
    readonly comment: string;
  };

function randomBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function deterministicBytes(seed: string): RandomBytes {
  let counter = 0;
  let pool = new Uint8Array(0);
  return (count: number) => {
    while (pool.length < count) {
      const block = sha256(utf8ToBytes(`${seed}#${counter++}`));
      const grown = new Uint8Array(pool.length + block.length);
      grown.set(pool);
      grown.set(block, pool.length);
      pool = grown;
    }
    const out = pool.slice(0, count);
    pool = pool.slice(count);
    return out;
  };
}

function decodedOrLiteral(text: string): Uint8Array {
  try {
    return base64ToBytes(text);
  } catch {
    return utf8ToBytes(text);
  }
}

export function keygenBits(algorithm: string, requested?: number): number {
  if (algorithm === 'ssh-rsa') return requested ?? 3072;
  return 256;
}

function bigIntToBytes(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = length - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

function generateKey(algorithm: string, comment: string, bits: number, random: RandomBytes): SshPrivateKey {
  if (algorithm === 'ssh-rsa') {
    const { privateKey } = generateRsaKeyPair(Math.ceil(bits / 16) * 16, random);
    const p = privateKey.p!;
    const q = privateKey.q!;
    return {
      algorithm, n: privateKey.n, e: privateKey.e, d: privateKey.d,
      iqmp: modInverse(q, p), p, q, comment,
    };
  }
  if (algorithm === 'ecdsa-sha2-nistp256') {
    const d = generateP256PrivateScalar(random);
    const point = p256PublicKey(d);
    const q = new Uint8Array(1 + 2 * P256_FIELD_BYTES);
    q[0] = 0x04;
    q.set(bigIntToBytes(point.x, P256_FIELD_BYTES), 1);
    q.set(bigIntToBytes(point.y, P256_FIELD_BYTES), 1 + P256_FIELD_BYTES);
    return { algorithm, q, d, comment };
  }
  const seed = random(32);
  return { algorithm: 'ssh-ed25519', seed, publicKey: ed25519PublicKey(seed), comment };
}

export type SshPublicKey =
  | { readonly algorithm: 'ssh-ed25519'; readonly publicKey: Uint8Array }
  | { readonly algorithm: 'ssh-rsa'; readonly e: bigint; readonly n: bigint }
  | { readonly algorithm: 'ecdsa-sha2-nistp256'; readonly q: Uint8Array };

export function sshPublicKeyFromBlob(blob: Uint8Array): SshPublicKey | null {
  try {
    const reader = new SshReader(blob);
    const algorithm = reader.readString();
    let key: SshPublicKey | null = null;
    if (algorithm === 'ssh-ed25519') {
      const publicKey = reader.readBytes();
      key = publicKey.length === 32 ? { algorithm, publicKey } : null;
    } else if (algorithm === 'ssh-rsa') {
      const e = reader.readMpint();
      key = { algorithm, e, n: reader.readMpint() };
    } else if (algorithm === 'ecdsa-sha2-nistp256') {
      if (reader.readString() !== NISTP256) return null;
      const q = reader.readBytes();
      key = q.length === 1 + 2 * P256_FIELD_BYTES && q[0] === 0x04 ? { algorithm, q } : null;
    }
    return key !== null && reader.remaining === 0 ? key : null;
  } catch {
    return null;
  }
}

export function sshPublicKeyBlob(key: SshPublicKey): Uint8Array {
  const writer = new SshWriter().writeString(key.algorithm);
  if (key.algorithm === 'ssh-rsa') return writer.writeMpint(key.e).writeMpint(key.n).toBytes();
  if (key.algorithm === 'ecdsa-sha2-nistp256') return writer.writeString(NISTP256).writeBytes(key.q).toBytes();
  return writer.writeBytes(key.publicKey).toBytes();
}

function publicLine(key: SshPrivateKey): string {
  return `${key.algorithm} ${bytesToBase64(sshPublicKeyBlob(key))} ${key.comment}`;
}

function privateSection(key: SshPrivateKey, checkint: number): Uint8Array {
  const writer = new SshWriter().writeUint32(checkint).writeUint32(checkint).writeString(key.algorithm);
  if (key.algorithm === 'ssh-rsa') {
    writer.writeMpint(key.n).writeMpint(key.e).writeMpint(key.d)
      .writeMpint(key.iqmp).writeMpint(key.p).writeMpint(key.q);
  } else if (key.algorithm === 'ecdsa-sha2-nistp256') {
    writer.writeString(NISTP256).writeBytes(key.q).writeMpint(key.d);
  } else {
    const secret = new Uint8Array(64);
    secret.set(key.seed);
    secret.set(key.publicKey, 32);
    writer.writeBytes(key.publicKey).writeBytes(secret);
  }
  writer.writeString(key.comment);
  const unpadded = writer.toBytes().length;
  for (let pad = 1; (unpadded + pad - 1) % UNENCRYPTED_BLOCK_SIZE !== 0; pad++) writer.writeByte(pad);
  return writer.toBytes();
}

function privateFile(key: SshPrivateKey, checkint: number): string {
  const body = new SshWriter()
    .writeRaw(utf8ToBytes(AUTH_MAGIC))
    .writeString('none')
    .writeString('none')
    .writeString('')
    .writeUint32(1)
    .writeBytes(sshPublicKeyBlob(key))
    .writeBytes(privateSection(key, checkint))
    .toBytes();
  const armoured = bytesToBase64(body);
  const lines: string[] = [];
  for (let at = 0; at < armoured.length; at += ARMOUR_LINE_LENGTH) lines.push(armoured.slice(at, at + ARMOUR_LINE_LENGTH));
  return `${PRIVATE_HEADER}\n${lines.join('\n')}\n${PRIVATE_FOOTER}\n`;
}

function checkintFrom(random: RandomBytes): number {
  const [a, b, c, d] = random(4);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function pairFor(key: SshPrivateKey, random: RandomBytes): KeygenPair {
  return { pub: publicLine(key), priv: privateFile(key, checkintFrom(random)) };
}

export function keygenDeterministicPair(
  algorithm: string, seed: string, comment: string, bits?: number,
): KeygenPair {
  const random = deterministicBytes(seed);
  return pairFor(generateKey(algorithm, comment, keygenBits(algorithm, bits), random), random);
}

export function keygenPair(algorithm: string, comment: string, bits?: number): KeygenPair {
  return pairFor(generateKey(algorithm, comment, keygenBits(algorithm, bits), randomBytes), randomBytes);
}

function readPrivateKey(reader: SshReader, algorithm: string): SshPrivateKey | null {
  if (algorithm === 'ssh-rsa') {
    const [n, e, d, iqmp, p, q] = [0, 1, 2, 3, 4, 5].map(() => reader.readMpint());
    return { algorithm, n, e, d, iqmp, p, q, comment: reader.readString() };
  }
  if (algorithm === 'ecdsa-sha2-nistp256') {
    if (reader.readString() !== NISTP256) return null;
    const q = reader.readBytes();
    const d = reader.readMpint();
    return { algorithm, q, d, comment: reader.readString() };
  }
  if (algorithm === 'ssh-ed25519') {
    const publicKey = reader.readBytes();
    const secret = reader.readBytes();
    if (publicKey.length !== 32 || secret.length !== 64) return null;
    return { algorithm, seed: secret.slice(0, 32), publicKey, comment: reader.readString() };
  }
  return null;
}

export function keygenPrivateKey(material: string): SshPrivateKey | null {
  const body = material.replace(PRIVATE_HEADER, '').replace(PRIVATE_FOOTER, '').replace(/\s+/g, '');
  if (body === '') return null;
  try {
    const outer = new SshReader(base64ToBytes(body));
    const magic = outer.readRaw(AUTH_MAGIC.length);
    if (new TextDecoder().decode(magic) !== AUTH_MAGIC) return null;
    if (outer.readString() !== 'none' || outer.readString() !== 'none') return null;
    outer.readBytes();
    if (outer.readUint32() !== 1) return null;
    outer.readBytes();
    const inner = new SshReader(outer.readBytes());
    if (inner.readUint32() !== inner.readUint32()) return null;
    return readPrivateKey(inner, inner.readString());
  } catch {
    return null;
  }
}

export function keygenPublicOf(material: string): string | null {
  const key = keygenPrivateKey(material);
  return key === null ? null : publicLine(key);
}

const ALGORITHM_LABELS: Readonly<Record<string, string>> = {
  'ssh-ed25519': 'ED25519',
  'ssh-rsa': 'RSA',
  'rsa-sha2-256': 'RSA',
  'rsa-sha2-512': 'RSA',
  'ecdsa-sha2-nistp256': 'ECDSA',
};

export function sshKeyTypeLabel(algorithm: string): string {
  return ALGORITHM_LABELS[algorithm] ?? algorithm.toUpperCase();
}

export interface KeygenKeyFacts {
  readonly label: string;
  readonly bits: number;
  readonly comment: string;
}

function publicKeyBits(algorithm: string, blob: string): number {
  if (algorithm !== 'ssh-rsa') return 256;
  try {
    const reader = new SshReader(base64ToBytes(blob));
    reader.readString();
    reader.readMpint();
    return bitLength(reader.readMpint());
  } catch {
    return 0;
  }
}

export function keygenKeyFacts(publicLine: string): KeygenKeyFacts {
  const tokens = publicLine.trim().split(/\s+/);
  const algorithm = tokens[0] ?? '';
  return {
    label: sshKeyTypeLabel(algorithm),
    bits: publicKeyBits(algorithm, tokens[1] ?? ''),
    comment: tokens.slice(2).join(' '),
  };
}

const FINGERPRINT_HASHES: Readonly<Record<string, { readonly label: string; readonly digest: (bytes: Uint8Array) => Uint8Array }>> = {
  md5: { label: 'MD5', digest: md5 },
  sha1: { label: 'SHA1', digest: sha1 },
  sha256: { label: 'SHA256', digest: sha256 },
  sha384: { label: 'SHA384', digest: sha384 },
  sha512: { label: 'SHA512', digest: sha512 },
};

export function isFingerprintHash(name: string): boolean {
  return FINGERPRINT_HASHES[name.toLowerCase()] !== undefined;
}

export function keygenBlobDigest(blob: string, hash: string): string | null {
  const fingerprintHash = FINGERPRINT_HASHES[hash.trim().toLowerCase() || 'sha256'];
  if (fingerprintHash === undefined) return null;
  const digest = fingerprintHash.digest(decodedOrLiteral(blob));
  return fingerprintHash.label === 'MD5'
    ? `MD5:${[...digest].map(b => b.toString(16).padStart(2, '0')).join(':')}`
    : `${fingerprintHash.label}:${bytesToBase64(digest).replace(/=+$/, '')}`;
}

export function keygenDigest(publicLine: string, hash: string): string | null {
  return keygenBlobDigest(publicLine.trim().split(/\s+/)[1] ?? '', hash);
}

export function keygenFingerprint(publicLine: string, hash: string): string | null {
  const digest = keygenDigest(publicLine, hash);
  if (digest === null) return null;
  const facts = keygenKeyFacts(publicLine);
  return `${facts.bits} ${digest} ${facts.comment || 'no comment'} (${facts.label})`;
}

const RANDOMART_WIDTH = 17;
const RANDOMART_HEIGHT = 9;
const RANDOMART_SYMBOLS = ' .o+=*BOX@%&#/^SE';

function randomartBorder(label: string): string {
  const left = Math.floor((RANDOMART_WIDTH - label.length) / 2);
  return `+${'-'.repeat(Math.max(0, left))}${label}${'-'.repeat(Math.max(0, RANDOMART_WIDTH - left - label.length))}+`;
}

export function keygenRandomart(publicLine: string, hash = 'sha256'): string {
  const facts = keygenKeyFacts(publicLine);
  const fingerprintHash = FINGERPRINT_HASHES[hash.toLowerCase()] ?? FINGERPRINT_HASHES.sha256;
  const digest = fingerprintHash.digest(decodedOrLiteral(publicLine.trim().split(/\s+/)[1] ?? ''));
  const field = Array.from({ length: RANDOMART_WIDTH }, () => new Array<number>(RANDOMART_HEIGHT).fill(0));
  const last = RANDOMART_SYMBOLS.length - 1;
  const startX = Math.floor(RANDOMART_WIDTH / 2);
  const startY = Math.floor(RANDOMART_HEIGHT / 2);
  let x = startX;
  let y = startY;
  for (const byte of digest) {
    let input = byte;
    for (let step = 0; step < 4; step++) {
      x = Math.min(Math.max(x + ((input & 1) ? 1 : -1), 0), RANDOMART_WIDTH - 1);
      y = Math.min(Math.max(y + ((input & 2) ? 1 : -1), 0), RANDOMART_HEIGHT - 1);
      if (field[x][y] < last - 2) field[x][y]++;
      input >>= 2;
    }
  }
  field[startX][startY] = last - 1;
  field[x][y] = last;
  const rows = [randomartBorder(`[${facts.label} ${facts.bits}]`)];
  for (let row = 0; row < RANDOMART_HEIGHT; row++) {
    let line = '|';
    for (let col = 0; col < RANDOMART_WIDTH; col++) line += RANDOMART_SYMBOLS[Math.min(field[col][row], last)];
    rows.push(`${line}|`);
  }
  rows.push(randomartBorder(`[${fingerprintHash.label}]`));
  return rows.join('\n');
}
