import { sha256 } from '@/crypto/hash/sha256';
import { md5 } from '@/crypto/hash/md5';

export const KEYGEN_ALGORITHMS: Readonly<Record<string, string>> = {
  ed25519: 'ssh-ed25519',
  rsa: 'ssh-rsa',
  ecdsa: 'ecdsa-sha2-nistp256',
};

const PRIVATE_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';
const PRIVATE_FOOTER = '-----END OPENSSH PRIVATE KEY-----';

export interface KeygenPair {
  readonly pub: string;
  readonly priv: string;
}

interface KeygenSecret {
  readonly algorithm: string;
  readonly key: string;
  readonly comment: string;
  readonly bits: number;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function lengthPrefixed(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += 4 + part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out[at] = (part.length >>> 24) & 0xff;
    out[at + 1] = (part.length >>> 16) & 0xff;
    out[at + 2] = (part.length >>> 8) & 0xff;
    out[at + 3] = part.length & 0xff;
    out.set(part, at + 4);
    at += 4 + part.length;
  }
  return out;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function randomBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export function keygenBits(algorithm: string, requested?: number): number {
  if (algorithm === 'ssh-rsa') {
    return requested !== undefined && requested >= 1024 ? requested : 3072;
  }
  return 256;
}

function publicBlob(algorithm: string, key: Uint8Array): string {
  if (algorithm === 'ssh-rsa') {
    return toBase64(lengthPrefixed([ascii(algorithm), new Uint8Array([1, 0, 1]), key]));
  }
  if (algorithm === 'ecdsa-sha2-nistp256') {
    return toBase64(lengthPrefixed([ascii(algorithm), ascii('nistp256'), key]));
  }
  return toBase64(lengthPrefixed([ascii(algorithm), key]));
}

function keyLengthFor(algorithm: string, bits: number): number {
  if (algorithm === 'ssh-rsa') return Math.ceil(bits / 8);
  if (algorithm === 'ecdsa-sha2-nistp256') return 65;
  return 32;
}

export function keygenDeterministicPublicBlob(algorithm: string, seed: string): string {
  const length = keyLengthFor(algorithm, keygenBits(algorithm));
  const key = new Uint8Array(length);
  for (let offset = 0, counter = 0; offset < length; offset += 32, counter++) {
    key.set(sha256(ascii(`${seed}#${counter}`)).subarray(0, Math.min(32, length - offset)), offset);
  }
  return publicBlob(algorithm, key);
}

export function keygenPair(algorithm: string, comment: string, bits?: number): KeygenPair {
  const size = keygenBits(algorithm, bits);
  const key = randomBytes(keyLengthFor(algorithm, size));
  const secret: KeygenSecret = {
    algorithm, key: toBase64(key), comment, bits: size,
  };
  const armoured = toBase64(ascii(JSON.stringify(secret)));
  const wrapped = armoured.match(/.{1,70}/g) ?? [armoured];
  return {
    pub: `${algorithm} ${publicBlob(algorithm, key)} ${comment}`,
    priv: `${PRIVATE_HEADER}\n${wrapped.join('\n')}\n${PRIVATE_FOOTER}\n`,
  };
}

function readSecret(material: string): KeygenSecret | null {
  const body = material
    .replace(PRIVATE_HEADER, '')
    .replace(PRIVATE_FOOTER, '')
    .replace(/\s+/g, '');
  if (body === '') return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64(body))) as Partial<KeygenSecret>;
    if (typeof parsed.algorithm !== 'string' || typeof parsed.key !== 'string') return null;
    return {
      algorithm: parsed.algorithm,
      key: parsed.key,
      comment: typeof parsed.comment === 'string' ? parsed.comment : '',
      bits: typeof parsed.bits === 'number' ? parsed.bits : 256,
    };
  } catch {
    return null;
  }
}

export function keygenPublicOf(material: string): string | null {
  const secret = readSecret(material);
  if (secret === null) return null;
  return `${secret.algorithm} ${publicBlob(secret.algorithm, fromBase64(secret.key))} ${secret.comment}`;
}

const ALGORITHM_LABELS: Readonly<Record<string, string>> = {
  'ssh-ed25519': 'ED25519',
  'ssh-rsa': 'RSA',
  'ecdsa-sha2-nistp256': 'ECDSA',
};

export interface KeygenKeyFacts {
  readonly label: string;
  readonly bits: number;
  readonly comment: string;
}

export function keygenKeyFacts(publicLine: string): KeygenKeyFacts {
  const tokens = publicLine.trim().split(/\s+/);
  const algorithm = tokens[0] ?? '';
  const bytes = fromBase64(tokens[1] ?? '');
  return {
    label: ALGORITHM_LABELS[algorithm] ?? algorithm.toUpperCase(),
    bits: algorithm === 'ssh-rsa'
      ? (bytes.length - 4 - algorithm.length - 4 - 3 - 4) * 8
      : 256,
    comment: tokens.slice(2).join(' '),
  };
}

export function keygenBlobDigest(blob: string, hash: string): string | null {
  const wanted = hash.trim().toLowerCase() || 'sha256';
  if (wanted !== 'sha256' && wanted !== 'md5') return null;
  const bytes = fromBase64(blob);
  return wanted === 'sha256'
    ? `SHA256:${toBase64(sha256(bytes)).replace(/=+$/, '')}`
    : `MD5:${[...md5(bytes)].map(b => b.toString(16).padStart(2, '0')).join(':')}`;
}

export function keygenDigest(publicLine: string, hash: string): string | null {
  return keygenBlobDigest(publicLine.trim().split(/\s+/)[1] ?? '', hash);
}

export function keygenFingerprint(publicLine: string, hash: string): string | null {
  const digest = keygenDigest(publicLine, hash);
  if (digest === null) return null;
  const facts = keygenKeyFacts(publicLine);
  return `${facts.bits} ${digest} ${facts.comment} (${facts.label})`;
}

export function keygenRandomart(publicLine: string): string {
  const tokens = publicLine.trim().split(/\s+/);
  const label = ALGORITHM_LABELS[tokens[0] ?? ''] ?? 'KEY';
  const digest = sha256(fromBase64(tokens[1] ?? ''));
  const glyphs = ' .o+=*BOX@%&#/^';
  const rows: string[] = [`+--[${label.padEnd(6)}]----+`];
  for (let y = 0; y < 9; y++) {
    let line = '|';
    for (let x = 0; x < 17; x++) {
      line += glyphs[digest[(y * 17 + x) % digest.length] % glyphs.length];
    }
    rows.push(`${line}|`);
  }
  rows.push('+----[SHA256]-----+');
  return rows.join('\n');
}
