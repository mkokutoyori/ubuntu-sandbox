import { sha256 } from '@/crypto/hash/sha256';
import { md5 } from '@/crypto/hash/md5';
import { sha1 } from '@/crypto/hash/sha1';
import { sha384, sha512 } from '@/crypto/hash/sha512';
import { base64ToBytes, bytesToBase64, utf8ToBytes } from '@/crypto/encoding';
import { ed25519PublicKey } from '@/crypto/ecc/ed25519';
import { NIST_CURVES, type NistCurveName } from '@/crypto/ecc/nistCurves';
import { bcryptPbkdf } from '@/crypto/kdf/bcryptPbkdf';
import { cipherSpec } from '@/network/protocols/ssh/transport/SshBinaryPacket';
import { bitLength, generateRsaKeyPair, modInverse, type RandomBytes } from '@/crypto/rsa/rsa';
import { SshReader, SshWriter } from '@/network/protocols/ssh/wire/SshDataTypes';
import { pemLoadPrivate, pemPrivateSupports, pemSerializePrivate, type PemPrivateFormat } from './SshPrivateKeyPem';

export type EcdsaAlgorithm = 'ecdsa-sha2-nistp256' | 'ecdsa-sha2-nistp384' | 'ecdsa-sha2-nistp521';

export const KEYGEN_ALGORITHMS: Readonly<Record<string, string>> = {
  ed25519: 'ssh-ed25519',
  rsa: 'ssh-rsa',
  ecdsa: 'ecdsa-sha2-nistp256',
};

const ECDSA_CURVE_OF: Readonly<Record<EcdsaAlgorithm, NistCurveName>> = {
  'ecdsa-sha2-nistp256': 'nistp256',
  'ecdsa-sha2-nistp384': 'nistp384',
  'ecdsa-sha2-nistp521': 'nistp521',
};

const ECDSA_ALGORITHM_OF_BITS: Readonly<Record<number, EcdsaAlgorithm>> = {
  256: 'ecdsa-sha2-nistp256',
  384: 'ecdsa-sha2-nistp384',
  521: 'ecdsa-sha2-nistp521',
};

export function isEcdsaAlgorithm(algorithm: string): algorithm is EcdsaAlgorithm {
  return algorithm in ECDSA_CURVE_OF;
}

export function isEcdsaKey<T extends { readonly algorithm: string }>(key: T): key is Extract<T, { readonly algorithm: EcdsaAlgorithm }> {
  return isEcdsaAlgorithm(key.algorithm);
}

export function ecdsaCurveOf(algorithm: EcdsaAlgorithm) {
  return NIST_CURVES[ECDSA_CURVE_OF[algorithm]];
}

export function keygenAlgorithmFor(type: string, bits?: number): string | undefined {
  const algorithm = KEYGEN_ALGORITHMS[type];
  if (type === 'ecdsa' && bits !== undefined) return ECDSA_ALGORITHM_OF_BITS[bits] ?? algorithm;
  return algorithm;
}

const PRIVATE_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';
const PRIVATE_FOOTER = '-----END OPENSSH PRIVATE KEY-----';
const AUTH_MAGIC = 'openssh-key-v1\0';
const UNENCRYPTED_BLOCK_SIZE = 8;
const ARMOUR_LINE_LENGTH = 70;
const DEFAULT_KEY_CIPHER = 'aes256-ctr';
const DEFAULT_KDF_ROUNDS = 16;
const KDF_SALT_BYTES = 16;

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
    readonly algorithm: EcdsaAlgorithm;
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
  if (isEcdsaAlgorithm(algorithm)) return ecdsaCurveBits(algorithm);
  return 256;
}

function ecdsaCurveBits(algorithm: EcdsaAlgorithm): number {
  return Number(algorithm.slice('ecdsa-sha2-nistp'.length));
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
  if (isEcdsaAlgorithm(algorithm)) {
    const curve = ecdsaCurveOf(algorithm);
    const d = curve.generatePrivateScalar(random);
    return { algorithm, q: curve.encodePoint(curve.publicKey(d)), d, comment };
  }
  const seed = random(32);
  return { algorithm: 'ssh-ed25519', seed, publicKey: ed25519PublicKey(seed), comment };
}

export type SshPublicKey =
  | { readonly algorithm: 'ssh-ed25519'; readonly publicKey: Uint8Array }
  | { readonly algorithm: 'ssh-rsa'; readonly e: bigint; readonly n: bigint }
  | { readonly algorithm: EcdsaAlgorithm; readonly q: Uint8Array };

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
    } else if (isEcdsaAlgorithm(algorithm)) {
      if (reader.readString() !== ECDSA_CURVE_OF[algorithm]) return null;
      const q = reader.readBytes();
      key = ecdsaCurveOf(algorithm).decodePoint(q) === null ? null : { algorithm, q };
    }
    return key !== null && reader.remaining === 0 ? key : null;
  } catch {
    return null;
  }
}

export function sshPublicKeyBlob(key: SshPublicKey): Uint8Array {
  const writer = new SshWriter().writeString(key.algorithm);
  if (key.algorithm === 'ssh-rsa') return writer.writeMpint(key.e).writeMpint(key.n).toBytes();
  if (isEcdsaKey(key)) return writer.writeString(ECDSA_CURVE_OF[key.algorithm]).writeBytes(key.q).toBytes();
  return writer.writeBytes(key.publicKey).toBytes();
}

export function keygenPublicLineOf(key: SshPrivateKey): string {
  return `${key.algorithm} ${bytesToBase64(sshPublicKeyBlob(key))} ${key.comment}`;
}

const publicLine = keygenPublicLineOf;

function privateSection(key: SshPrivateKey, checkint: number, blockSize: number): Uint8Array {
  const writer = new SshWriter().writeUint32(checkint).writeUint32(checkint).writeString(key.algorithm);
  if (key.algorithm === 'ssh-rsa') {
    writer.writeMpint(key.n).writeMpint(key.e).writeMpint(key.d)
      .writeMpint(key.iqmp).writeMpint(key.p).writeMpint(key.q);
  } else if (isEcdsaKey(key)) {
    writer.writeString(ECDSA_CURVE_OF[key.algorithm]).writeBytes(key.q).writeMpint(key.d);
  } else {
    const secret = new Uint8Array(64);
    secret.set(key.seed);
    secret.set(key.publicKey, 32);
    writer.writeBytes(key.publicKey).writeBytes(secret);
  }
  writer.writeString(key.comment);
  const unpadded = writer.toBytes().length;
  for (let pad = 1; (unpadded + pad - 1) % blockSize !== 0; pad++) writer.writeByte(pad);
  return writer.toBytes();
}

export interface PrivateKeyProtection {
  readonly passphrase: string;
  readonly format?: PemPrivateFormat;
  readonly cipher?: string;
  readonly rounds?: number;
}

export function keygenKeyCiphers(): readonly string[] {
  return ['3des-cbc', 'aes128-cbc', 'aes192-cbc', 'aes256-cbc', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
    'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'chacha20-poly1305@openssh.com'];
}

function wrapArmour(body: Uint8Array): string {
  const armoured = bytesToBase64(body);
  const lines: string[] = [];
  for (let at = 0; at < armoured.length; at += ARMOUR_LINE_LENGTH) lines.push(armoured.slice(at, at + ARMOUR_LINE_LENGTH));
  return `${PRIVATE_HEADER}\n${lines.join('\n')}\n${PRIVATE_FOOTER}\n`;
}

export function keygenSerializePrivate(
  key: SshPrivateKey, protection: PrivateKeyProtection | undefined, random: RandomBytes = randomBytes,
): string {
  if (protection?.format !== undefined && pemPrivateSupports(key.algorithm)) {
    return pemSerializePrivate(key, protection.format, protection.passphrase, random);
  }
  const checkint = checkintFrom(random);
  const encrypted = protection !== undefined && protection.passphrase !== '';
  const cipherName = encrypted ? protection.cipher ?? DEFAULT_KEY_CIPHER : 'none';
  const spec = encrypted ? cipherSpec(cipherName) : null;
  if (encrypted && spec === null) throw new RangeError(`unsupported key cipher ${cipherName}`);
  const blockSize = Math.max(UNENCRYPTED_BLOCK_SIZE, spec?.blockSize ?? 0);
  const plain = privateSection(key, checkint, blockSize);
  let kdfOptions = new Uint8Array(0);
  let section = plain;
  if (encrypted && spec !== null) {
    const salt = random(KDF_SALT_BYTES);
    const rounds = protection.rounds ?? DEFAULT_KDF_ROUNDS;
    kdfOptions = new SshWriter().writeBytes(salt).writeUint32(rounds).toBytes();
    const derived = bcryptPbkdf(utf8ToBytes(protection.passphrase), salt, spec.keyLength + spec.ivLength, rounds);
    section = spec.create(derived.slice(0, spec.keyLength), derived.slice(spec.keyLength)).crypt(0, plain, 0, true)!;
  }
  const body = new SshWriter()
    .writeRaw(utf8ToBytes(AUTH_MAGIC))
    .writeString(cipherName)
    .writeString(encrypted ? 'bcrypt' : 'none')
    .writeBytes(kdfOptions)
    .writeUint32(1)
    .writeBytes(sshPublicKeyBlob(key))
    .writeBytes(section)
    .toBytes();
  return wrapArmour(body);
}

function checkintFrom(random: RandomBytes): number {
  const [a, b, c, d] = random(4);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function pairFor(key: SshPrivateKey, random: RandomBytes, protection?: PrivateKeyProtection): KeygenPair {
  return { pub: publicLine(key), priv: keygenSerializePrivate(key, protection, random) };
}

const deterministicPairs = new Map<string, KeygenPair>();

export function keygenDeterministicPair(
  algorithm: string, seed: string, comment: string, bits?: number,
): KeygenPair {
  const cacheKey = JSON.stringify([algorithm, seed, comment, bits]);
  const known = deterministicPairs.get(cacheKey);
  if (known !== undefined) return known;
  const random = deterministicBytes(seed);
  const pair = pairFor(generateKey(algorithm, comment, keygenBits(algorithm, bits), random), random);
  deterministicPairs.set(cacheKey, pair);
  return pair;
}

export function keygenPair(
  algorithm: string, comment: string, bits?: number, protection?: PrivateKeyProtection,
): KeygenPair {
  return pairFor(generateKey(algorithm, comment, keygenBits(algorithm, bits), randomBytes), randomBytes, protection);
}

function readPrivateKey(reader: SshReader, algorithm: string): SshPrivateKey | null {
  if (algorithm === 'ssh-rsa') {
    const [n, e, d, iqmp, p, q] = [0, 1, 2, 3, 4, 5].map(() => reader.readMpint());
    return { algorithm, n, e, d, iqmp, p, q, comment: reader.readString() };
  }
  if (isEcdsaAlgorithm(algorithm)) {
    if (reader.readString() !== ECDSA_CURVE_OF[algorithm]) return null;
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

export type PrivateKeyLoad =
  | { readonly kind: 'key'; readonly key: SshPrivateKey }
  | { readonly kind: 'encrypted'; readonly cipher: string }
  | { readonly kind: 'wrong-passphrase' }
  | { readonly kind: 'invalid-format' }
  | { readonly kind: 'unsupported-cipher'; readonly cipher: string };

export function keygenLoadPrivate(material: string, passphrase = ''): PrivateKeyLoad {
  const pem = pemLoadPrivate(material, passphrase);
  if (pem !== null) return pem;
  const body = material.replace(PRIVATE_HEADER, '').replace(PRIVATE_FOOTER, '').replace(/\s+/g, '');
  if (body === '') return { kind: 'invalid-format' };
  try {
    const outer = new SshReader(base64ToBytes(body));
    const magic = outer.readRaw(AUTH_MAGIC.length);
    if (new TextDecoder().decode(magic) !== AUTH_MAGIC) return { kind: 'invalid-format' };
    const cipherName = outer.readString();
    const kdfName = outer.readString();
    const kdfOptions = outer.readBytes();
    if (outer.readUint32() !== 1) return { kind: 'invalid-format' };
    outer.readBytes();
    let section = outer.readBytes();
    if (cipherName !== 'none') {
      const spec = cipherSpec(cipherName);
      if (spec === null || kdfName !== 'bcrypt') return { kind: 'unsupported-cipher', cipher: cipherName };
      if (passphrase === '') return { kind: 'encrypted', cipher: cipherName };
      const options = new SshReader(kdfOptions);
      const salt = options.readBytes();
      const rounds = options.readUint32();
      const derived = bcryptPbkdf(utf8ToBytes(passphrase), salt, spec.keyLength + spec.ivLength, rounds);
      const opened = spec.create(derived.slice(0, spec.keyLength), derived.slice(spec.keyLength)).crypt(0, section, 0, false);
      if (opened === null) return { kind: 'wrong-passphrase' };
      section = opened;
    } else if (kdfName !== 'none') {
      return { kind: 'invalid-format' };
    }
    const inner = new SshReader(section);
    if (inner.readUint32() !== inner.readUint32()) {
      return cipherName === 'none' ? { kind: 'invalid-format' } : { kind: 'wrong-passphrase' };
    }
    const key = readPrivateKey(inner, inner.readString());
    return key === null ? { kind: 'invalid-format' } : { kind: 'key', key };
  } catch {
    return cipherNameOf(material) === 'none' ? { kind: 'invalid-format' } : { kind: 'wrong-passphrase' };
  }
}

function cipherNameOf(material: string): string {
  try {
    const outer = new SshReader(base64ToBytes(material.replace(PRIVATE_HEADER, '').replace(PRIVATE_FOOTER, '').replace(/\s+/g, '')));
    outer.readRaw(AUTH_MAGIC.length);
    return outer.readString();
  } catch {
    return 'none';
  }
}

export function keygenPrivateKey(material: string, passphrase = ''): SshPrivateKey | null {
  const loaded = keygenLoadPrivate(material, passphrase);
  return loaded.kind === 'key' ? loaded.key : null;
}

export function keygenPublicOf(material: string, passphrase = ''): string | null {
  const key = keygenPrivateKey(material, passphrase);
  return key === null ? null : publicLine(key);
}

export function keygenPublicBlobOfFile(material: string): Uint8Array | null {
  const pem = pemLoadPrivate(material, '');
  if (pem !== null) return pem.kind === 'key' ? sshPublicKeyBlob(pem.key) : null;
  try {
    const outer = new SshReader(base64ToBytes(material.replace(PRIVATE_HEADER, '').replace(PRIVATE_FOOTER, '').replace(/\s+/g, '')));
    outer.readRaw(AUTH_MAGIC.length);
    outer.readString(); outer.readString(); outer.readBytes();
    if (outer.readUint32() !== 1) return null;
    return outer.readBytes();
  } catch {
    return null;
  }
}

export function keygenKeyWithComment(key: SshPrivateKey, comment: string): SshPrivateKey {
  return { ...key, comment };
}

const ALGORITHM_LABELS: Readonly<Record<string, string>> = {
  'ssh-ed25519': 'ED25519',
  'ssh-rsa': 'RSA',
  'rsa-sha2-256': 'RSA',
  'rsa-sha2-512': 'RSA',
  'ecdsa-sha2-nistp256': 'ECDSA',
  'ecdsa-sha2-nistp384': 'ECDSA',
  'ecdsa-sha2-nistp521': 'ECDSA',
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
  if (isEcdsaAlgorithm(algorithm)) return ecdsaCurveBits(algorithm);
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

const BABBLE_VOWELS = 'aeiouy';
const BABBLE_CONSONANTS = 'bcdfghklmnprstvzx';

export function keygenBubblebabble(publicLine: string): string | null {
  const blob = publicLine.trim().split(/\s+/)[1];
  if (blob === undefined) return null;
  const digest = sha1(decodedOrLiteral(blob));
  const rounds = Math.floor(digest.length / 2) + 1;
  let seed = 1;
  let out = 'x';
  for (let i = 0; i < rounds; i++) {
    if (i + 1 < rounds || digest.length % 2 !== 0) {
      out += BABBLE_VOWELS[(((digest[2 * i] >> 6) & 3) + seed) % 6];
      out += BABBLE_CONSONANTS[(digest[2 * i] >> 2) & 15];
      out += BABBLE_VOWELS[((digest[2 * i] & 3) + Math.floor(seed / 6)) % 6];
      if (i + 1 < rounds) {
        out += BABBLE_CONSONANTS[(digest[2 * i + 1] >> 4) & 15];
        out += '-';
        out += BABBLE_CONSONANTS[digest[2 * i + 1] & 15];
        seed = (seed * 5 + digest[2 * i] * 7 + digest[2 * i + 1]) % 36;
      }
    } else {
      out += BABBLE_VOWELS[seed % 6];
      out += BABBLE_CONSONANTS[16];
      out += BABBLE_VOWELS[Math.floor(seed / 6)];
    }
  }
  return `${out}x`;
}
