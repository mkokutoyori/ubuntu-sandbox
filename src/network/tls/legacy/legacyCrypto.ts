import { MD5, SHA1, SHA256, SHA384 } from '@/crypto/hash';
import type { HashAlgorithm } from '@/crypto/hash';
import { hmac } from '@/crypto/mac';
import {
  aesEncryptBlock, aesDecryptBlock, aesGcmEncrypt, aesGcmDecrypt, AES_GCM_TAG_SIZE,
  aesCcmEncrypt, aesCcmDecrypt, chacha20Poly1305Encrypt, chacha20Poly1305Decrypt,
} from '@/crypto/cipher';
import { tripleDesEncryptBlock, tripleDesDecryptBlock } from '@/crypto/cipher/des';
import { utf8ToBytes } from '@/crypto/encoding';
import type { TlsRecord } from '../recordLayer';
import { CONTENT_TYPE_CODE } from '../types';
import {
  PROTOCOL_VERSION_WIRE, type LegacySuiteDefinition, type LegacyVersion, type MacHash, type PrfHash,
} from './legacyCipherSuites';

const MASTER_SECRET_LENGTH = 48;
const VERIFY_DATA_LENGTH = 12;

function hashOf(name: PrfHash | MacHash): HashAlgorithm {
  switch (name) {
    case 'SHA384': return SHA384;
    case 'SHA256': return SHA256;
    case 'SHA1': return SHA1;
    default: throw new RangeError(`no hash for ${name}`);
  }
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function pHash(hash: HashAlgorithm, secret: Uint8Array, seed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let a = seed;
  let produced = 0;
  while (produced < length) {
    a = hmac(hash, secret, a);
    const block = hmac(hash, secret, concat(a, seed));
    const take = Math.min(block.length, length - produced);
    out.set(block.subarray(0, take), produced);
    produced += take;
  }
  return out;
}

export function tlsPrf(
  version: LegacyVersion, prf: PrfHash, secret: Uint8Array, label: string, seed: Uint8Array, length: number,
): Uint8Array {
  const labelSeed = concat(utf8ToBytes(label), seed);
  if (version === '1.2') return pHash(hashOf(prf), secret, labelSeed, length);
  const half = Math.ceil(secret.length / 2);
  const md5 = pHash(MD5, secret.subarray(0, half), labelSeed, length);
  const sha1 = pHash(SHA1, secret.subarray(secret.length - half), labelSeed, length);
  return md5.map((byte, index) => byte ^ sha1[index]);
}

export function masterSecret(
  version: LegacyVersion, prf: PrfHash, preMaster: Uint8Array,
  clientRandom: Uint8Array, serverRandom: Uint8Array,
): Uint8Array {
  return tlsPrf(version, prf, preMaster, 'master secret', concat(clientRandom, serverRandom), MASTER_SECRET_LENGTH);
}

export function handshakeHash(version: LegacyVersion, prf: PrfHash, messages: readonly Uint8Array[]): Uint8Array {
  const all = concat(...messages);
  if (version === '1.2') return hashOf(prf).digest(all);
  return concat(MD5.digest(all), SHA1.digest(all));
}

export function finishedVerifyData(
  version: LegacyVersion, prf: PrfHash, master: Uint8Array, role: 'client' | 'server',
  messages: readonly Uint8Array[],
): Uint8Array {
  return tlsPrf(version, prf, master, `${role} finished`, handshakeHash(version, prf, messages), VERIFY_DATA_LENGTH);
}

interface CipherShape {
  readonly encKeyLength: number;
  readonly blockSize: number;
  readonly fixedIvLength: number;
}

function cipherShape(suite: LegacySuiteDefinition): CipherShape {
  switch (suite.cipher) {
    case 'AES_128_GCM': return { encKeyLength: 16, blockSize: 0, fixedIvLength: 4 };
    case 'AES_256_GCM': return { encKeyLength: 32, blockSize: 0, fixedIvLength: 4 };
    case 'AES_128_CCM': case 'AES_128_CCM_8': return { encKeyLength: 16, blockSize: 0, fixedIvLength: 4 };
    case 'AES_256_CCM': case 'AES_256_CCM_8': return { encKeyLength: 32, blockSize: 0, fixedIvLength: 4 };
    case 'CHACHA20_POLY1305': return { encKeyLength: 32, blockSize: 0, fixedIvLength: 12 };
    case 'AES_128_CBC': return { encKeyLength: 16, blockSize: 16, fixedIvLength: 16 };
    case 'AES_256_CBC': return { encKeyLength: 32, blockSize: 16, fixedIvLength: 16 };
    case '3DES_EDE_CBC': return { encKeyLength: 24, blockSize: 8, fixedIvLength: 8 };
    default: throw new RangeError(`cipher ${suite.cipher} is not implemented`);
  }
}

function macLength(mac: MacHash): number {
  return mac === 'AEAD' ? 0 : hashOf(mac).digestSize;
}

export interface DirectionKeys {
  readonly macKey: Uint8Array;
  readonly encKey: Uint8Array;
  readonly fixedIv: Uint8Array;
}

export interface KeyBlock {
  readonly client: DirectionKeys;
  readonly server: DirectionKeys;
}

export function deriveKeyBlock(
  version: LegacyVersion, suite: LegacySuiteDefinition, master: Uint8Array,
  clientRandom: Uint8Array, serverRandom: Uint8Array,
): KeyBlock {
  const shape = cipherShape(suite);
  const macLen = macLength(suite.mac);
  const aead = suite.mac === 'AEAD';
  const ivLength = aead ? shape.fixedIvLength : (version === '1.0' ? shape.fixedIvLength : 0);
  const total = 2 * (macLen + shape.encKeyLength + ivLength);
  const block = tlsPrf(version, suite.prf, master, 'key expansion', concat(serverRandom, clientRandom), total);
  let offset = 0;
  const take = (length: number): Uint8Array => { const out = block.slice(offset, offset + length); offset += length; return out; };
  const clientMac = take(macLen);
  const serverMac = take(macLen);
  const clientKey = take(shape.encKeyLength);
  const serverKey = take(shape.encKeyLength);
  const clientIv = take(ivLength);
  const serverIv = take(ivLength);
  return {
    client: { macKey: clientMac, encKey: clientKey, fixedIv: clientIv },
    server: { macKey: serverMac, encKey: serverKey, fixedIv: serverIv },
  };
}

function seqBytes(seq: number): Uint8Array {
  const out = new Uint8Array(8);
  let rest = seq;
  for (let i = 7; i >= 0; i--) { out[i] = rest & 0xff; rest = Math.floor(rest / 256); }
  return out;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export class LegacyRecordProtection {
  readonly kind = 'legacy' as const;
  sequenceBase = 0;
  private chainIv: Uint8Array;

  constructor(
    private readonly version: LegacyVersion,
    private readonly suite: LegacySuiteDefinition,
    private readonly keys: DirectionKeys,
  ) {
    this.chainIv = keys.fixedIv;
  }

  get cipherSuite(): string { return this.suite.name; }

  private header(record: TlsRecord, length: number, seq: number): Uint8Array {
    const wire = PROTOCOL_VERSION_WIRE[this.version];
    return concat(seqBytes(seq), Uint8Array.from([
      CONTENT_TYPE_CODE[record.contentType], (wire >> 8) & 0xff, wire & 0xff, (length >> 8) & 0xff, length & 0xff,
    ]));
  }

  private blockEncrypt(block: Uint8Array): Uint8Array {
    return this.suite.cipher === '3DES_EDE_CBC'
      ? tripleDesEncryptBlock(this.keys.encKey, block)
      : aesEncryptBlock(this.keys.encKey, block);
  }

  private blockDecrypt(block: Uint8Array): Uint8Array {
    return this.suite.cipher === '3DES_EDE_CBC'
      ? tripleDesDecryptBlock(this.keys.encKey, block)
      : aesDecryptBlock(this.keys.encKey, block);
  }

  seal(seq: number, record: TlsRecord): TlsRecord {
    const absolute = seq + this.sequenceBase;
    return this.suite.mac === 'AEAD' ? this.sealAead(absolute, record) : this.sealCbc(absolute, record);
  }

  open(seq: number, record: TlsRecord): TlsRecord | null {
    const absolute = seq + this.sequenceBase;
    return this.suite.mac === 'AEAD' ? this.openAead(absolute, record) : this.openCbc(absolute, record);
  }

  private aeadTagLength(): number {
    return this.suite.cipher === 'AES_128_CCM_8' || this.suite.cipher === 'AES_256_CCM_8' ? 8 : AES_GCM_TAG_SIZE;
  }

  private aeadSeal(nonce: Uint8Array, aad: Uint8Array, plain: Uint8Array): { ciphertext: Uint8Array; tag: Uint8Array } {
    switch (this.suite.cipher) {
      case 'CHACHA20_POLY1305': return chacha20Poly1305Encrypt(this.keys.encKey, nonce, aad, plain);
      case 'AES_128_CCM': case 'AES_256_CCM': case 'AES_128_CCM_8': case 'AES_256_CCM_8':
        return aesCcmEncrypt(this.keys.encKey, nonce, aad, plain, this.aeadTagLength());
      default: return aesGcmEncrypt(this.keys.encKey, nonce, aad, plain);
    }
  }

  private aeadOpen(nonce: Uint8Array, aad: Uint8Array, cipher: Uint8Array, tag: Uint8Array): Uint8Array | null {
    switch (this.suite.cipher) {
      case 'CHACHA20_POLY1305': return chacha20Poly1305Decrypt(this.keys.encKey, nonce, aad, cipher, tag);
      case 'AES_128_CCM': case 'AES_256_CCM': case 'AES_128_CCM_8': case 'AES_256_CCM_8':
        return aesCcmDecrypt(this.keys.encKey, nonce, aad, cipher, tag);
      default: return aesGcmDecrypt(this.keys.encKey, nonce, aad, cipher, tag);
    }
  }

  private chachaNonce(seq: number): Uint8Array {
    const nonce = Uint8Array.from(this.keys.fixedIv);
    const sequence = seqBytes(seq);
    for (let i = 0; i < 8; i++) nonce[4 + i] ^= sequence[i];
    return nonce;
  }

  private sealAead(seq: number, record: TlsRecord): TlsRecord {
    const aad = this.header(record, record.fragment.length, seq);
    if (this.suite.cipher === 'CHACHA20_POLY1305') {
      const { ciphertext, tag } = this.aeadSeal(this.chachaNonce(seq), aad, record.fragment);
      return { ...record, legacyVersion: PROTOCOL_VERSION_WIRE[this.version], fragment: concat(ciphertext, tag) };
    }
    const explicit = seqBytes(seq);
    const { ciphertext, tag } = this.aeadSeal(concat(this.keys.fixedIv, explicit), aad, record.fragment);
    return { ...record, legacyVersion: PROTOCOL_VERSION_WIRE[this.version], fragment: concat(explicit, ciphertext, tag) };
  }

  private openAead(seq: number, record: TlsRecord): TlsRecord | null {
    const body = record.fragment;
    const tagLength = this.aeadTagLength();
    if (this.suite.cipher === 'CHACHA20_POLY1305') {
      if (body.length < tagLength) return null;
      const cipherLength = body.length - tagLength;
      const aad = this.header(record, cipherLength, seq);
      const plain = this.aeadOpen(this.chachaNonce(seq), aad, body.subarray(0, cipherLength), body.subarray(cipherLength));
      return plain === null ? null : { ...record, fragment: plain };
    }
    if (body.length < 8 + tagLength) return null;
    const explicit = body.subarray(0, 8);
    const cipherLength = body.length - 8 - tagLength;
    const aad = this.header(record, cipherLength, seq);
    const plain = this.aeadOpen(concat(this.keys.fixedIv, explicit), aad, body.subarray(8, 8 + cipherLength), body.subarray(8 + cipherLength));
    return plain === null ? null : { ...record, fragment: plain };
  }

  private macOf(record: TlsRecord, content: Uint8Array, seq: number): Uint8Array {
    return hmac(hashOf(this.suite.mac), this.keys.macKey, concat(this.header(record, content.length, seq), content));
  }

  private sealCbc(seq: number, record: TlsRecord): TlsRecord {
    const shape = cipherShape(this.suite);
    const block = shape.blockSize;
    const mac = this.macOf(record, record.fragment, seq);
    const unpadded = record.fragment.length + mac.length + 1;
    const padLength = (block - (unpadded % block)) % block;
    const plain = concat(record.fragment, mac, new Uint8Array(padLength + 1).fill(padLength));
    const explicitIv = this.version === '1.0' ? null : randomBytes(block);
    let previous = explicitIv ?? this.chainIv;
    const encrypted = new Uint8Array(plain.length);
    for (let offset = 0; offset < plain.length; offset += block) {
      const input = plain.slice(offset, offset + block);
      for (let i = 0; i < block; i++) input[i] ^= previous[i];
      previous = this.blockEncrypt(input);
      encrypted.set(previous, offset);
    }
    if (this.version === '1.0') this.chainIv = previous;
    return {
      ...record, legacyVersion: PROTOCOL_VERSION_WIRE[this.version],
      fragment: explicitIv ? concat(explicitIv, encrypted) : encrypted,
    };
  }

  private openCbc(seq: number, record: TlsRecord): TlsRecord | null {
    const shape = cipherShape(this.suite);
    const block = shape.blockSize;
    const explicit = this.version === '1.0' ? 0 : block;
    const body = record.fragment;
    if (body.length < explicit + block || (body.length - explicit) % block !== 0) return null;
    let previous = this.version === '1.0' ? this.chainIv : body.subarray(0, block);
    const plain = new Uint8Array(body.length - explicit);
    for (let offset = 0; offset < plain.length; offset += block) {
      const cipherBlock = body.subarray(explicit + offset, explicit + offset + block);
      const decrypted = this.blockDecrypt(cipherBlock);
      for (let i = 0; i < block; i++) decrypted[i] ^= previous[i];
      plain.set(decrypted, offset);
      previous = cipherBlock;
    }
    if (this.version === '1.0') this.chainIv = previous.slice();
    const padLength = plain[plain.length - 1];
    const macLen = macLength(this.suite.mac);
    if (plain.length < macLen + padLength + 1) return null;
    let paddingValid = true;
    for (let i = plain.length - padLength - 1; i < plain.length; i++) {
      if (plain[i] !== padLength) paddingValid = false;
    }
    const contentLength = plain.length - macLen - padLength - 1;
    const content = plain.slice(0, contentLength);
    const mac = plain.slice(contentLength, contentLength + macLen);
    const expected = this.macOf(record, content, seq);
    if (!paddingValid || !constantTimeEqual(mac, expected)) return null;
    return { ...record, fragment: content };
  }
}
