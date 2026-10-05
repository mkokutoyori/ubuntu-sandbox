import { aesGcmDecrypt, aesGcmEncrypt } from '@/crypto/cipher/aesGcm';
import { createAesEncryptor, AES_BLOCK_SIZE } from '@/crypto/cipher/aes';
import { chacha20Block, chacha20Xor, poly1305 } from '@/crypto/cipher/chacha20Poly1305';
import { hmac } from '@/crypto/mac/hmac';
import { SHA1 } from '@/crypto/hash/sha1';
import { SHA256 } from '@/crypto/hash/sha256';
import { SHA512 } from '@/crypto/hash/sha512';
import type { HashAlgorithm } from '@/crypto/hash/HashAlgorithm';

export const SSH_PACKET_MAX_SIZE = 256 * 1024;
export const SSH_MIN_PADDING = 4;
const CLEARTEXT_BLOCK_SIZE = 8;
const LENGTH_FIELD = 4;

export interface PacketCipher {
  readonly blockSize: number;
  readonly authLength: number;
  crypt(seq: number, input: Uint8Array, aadLength: number, encrypt: boolean): Uint8Array | null;
  length(seq: number, head: Uint8Array): number;
}

export interface CipherSpec {
  readonly name: string;
  readonly keyLength: number;
  readonly ivLength: number;
  readonly blockSize: number;
  readonly authLength: number;
  create(key: Uint8Array, iv: Uint8Array): PacketCipher;
}

export interface PacketMac {
  readonly length: number;
  readonly etm: boolean;
  compute(seq: number, data: Uint8Array): Uint8Array;
}

export interface MacSpec {
  readonly name: string;
  readonly keyLength: number;
  readonly etm: boolean;
  create(key: Uint8Array): PacketMac;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

function uint32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function uint64Nonce(seq: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(uint32(seq), 8);
  return nonce;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const NONE_CIPHER: PacketCipher = {
  blockSize: CLEARTEXT_BLOCK_SIZE,
  authLength: 0,
  crypt: (_seq, input) => input.slice(),
  length: (_seq, head) => readUint32(head, 0),
};

function aesCtr(name: string, keyLength: number): CipherSpec {
  return {
    name, keyLength, ivLength: AES_BLOCK_SIZE, blockSize: AES_BLOCK_SIZE, authLength: 0,
    create(key, iv) {
      const encryptBlock = createAesEncryptor(key);
      const counter = iv.slice(0, AES_BLOCK_SIZE);
      let keystream = new Uint8Array(0);
      let used = 0;
      const nextByte = (): number => {
        if (used === keystream.length) {
          keystream = encryptBlock(counter);
          used = 0;
          for (let i = AES_BLOCK_SIZE - 1; i >= 0; i--) {
            counter[i] = (counter[i] + 1) & 0xff;
            if (counter[i] !== 0) break;
          }
        }
        return keystream[used++];
      };
      return {
        blockSize: AES_BLOCK_SIZE,
        authLength: 0,
        crypt: (_seq, input, aadLength) => {
          const out = input.slice();
          for (let i = aadLength; i < out.length; i++) out[i] ^= nextByte();
          return out;
        },
        length: (_seq, head) => readUint32(head, 0),
      };
    },
  };
}

function aesGcm(name: string, keyLength: number): CipherSpec {
  const tagLength = 16;
  const ivLength = 12;
  return {
    name, keyLength, ivLength, blockSize: AES_BLOCK_SIZE, authLength: tagLength,
    create(key, initialIv) {
      const iv = initialIv.slice(0, ivLength);
      const nextIv = (): Uint8Array => {
        const current = iv.slice();
        for (let i = ivLength - 1; i >= 4; i--) {
          iv[i] = (iv[i] + 1) & 0xff;
          if (iv[i] !== 0) break;
        }
        return current;
      };
      return {
        blockSize: AES_BLOCK_SIZE,
        authLength: tagLength,
        crypt: (_seq, input, aadLength, encrypt) => {
          const aad = input.subarray(0, aadLength);
          if (encrypt) {
            const { ciphertext, tag } = aesGcmEncrypt(key, nextIv(), aad, input.subarray(aadLength));
            return concat(aad, ciphertext, tag);
          }
          const body = input.subarray(aadLength, input.length - tagLength);
          const plaintext = aesGcmDecrypt(key, nextIv(), aad, body, input.subarray(input.length - tagLength));
          return plaintext === null ? null : concat(aad, plaintext);
        },
        length: (_seq, head) => readUint32(head, 0),
      };
    },
  };
}

const chacha20Poly1305: CipherSpec = {
  name: 'chacha20-poly1305@openssh.com',
  keyLength: 64,
  ivLength: 0,
  blockSize: CLEARTEXT_BLOCK_SIZE,
  authLength: 16,
  create(key) {
    const mainKey = key.slice(0, 32);
    const headerKey = key.slice(32, 64);
    return {
      blockSize: CLEARTEXT_BLOCK_SIZE,
      authLength: 16,
      crypt: (seq, input, aadLength, encrypt) => {
        const nonce = uint64Nonce(seq);
        const polyKey = chacha20Block(mainKey, 0, nonce).subarray(0, 32);
        const covered = encrypt ? input.length : input.length - 16;
        if (!encrypt && !sameBytes(poly1305(polyKey, input.subarray(0, covered)), input.subarray(covered))) {
          return null;
        }
        const header = chacha20Xor(headerKey, 0, nonce, input.subarray(0, aadLength));
        const body = chacha20Xor(mainKey, 1, nonce, input.subarray(aadLength, covered));
        const out = concat(header, body);
        return encrypt ? concat(out, poly1305(polyKey, out)) : out;
      },
      length: (seq, head) => readUint32(chacha20Xor(headerKey, 0, uint64Nonce(seq), head.subarray(0, LENGTH_FIELD)), 0),
    };
  },
};

export const CIPHER_SPECS: readonly CipherSpec[] = [
  chacha20Poly1305,
  aesCtr('aes128-ctr', 16),
  aesCtr('aes192-ctr', 24),
  aesCtr('aes256-ctr', 32),
  aesGcm('aes128-gcm@openssh.com', 16),
  aesGcm('aes256-gcm@openssh.com', 32),
];

export function cipherSpec(name: string): CipherSpec | null {
  return CIPHER_SPECS.find((c) => c.name === name) ?? null;
}

function hmacSpec(name: string, hash: HashAlgorithm, etm: boolean): MacSpec {
  return {
    name, keyLength: hash.digestSize, etm,
    create: (key) => ({
      length: hash.digestSize,
      etm,
      compute: (seq, data) => hmac(hash, key, concat(uint32(seq), data)),
    }),
  };
}

export const MAC_SPECS: readonly MacSpec[] = [
  hmacSpec('hmac-sha2-256-etm@openssh.com', SHA256, true),
  hmacSpec('hmac-sha2-512-etm@openssh.com', SHA512, true),
  hmacSpec('hmac-sha1-etm@openssh.com', SHA1, true),
  hmacSpec('hmac-sha2-256', SHA256, false),
  hmacSpec('hmac-sha2-512', SHA512, false),
  hmacSpec('hmac-sha1', SHA1, false),
];

export function macSpec(name: string): MacSpec | null {
  return MAC_SPECS.find((m) => m.name === name) ?? null;
}

export interface PacketProtection {
  readonly cipher: PacketCipher;
  readonly mac: PacketMac | null;
}

export const CLEARTEXT: PacketProtection = { cipher: NONE_CIPHER, mac: null };

function aadLengthOf(protection: PacketProtection): number {
  return protection.cipher.authLength > 0 || protection.mac?.etm === true ? LENGTH_FIELD : 0;
}

export function encodePacket(
  payload: Uint8Array, protection: PacketProtection, seq: number, random: (n: number) => Uint8Array,
): Uint8Array {
  const { cipher, mac } = protection;
  const aadLength = aadLengthOf(protection);
  const blockSize = cipher.blockSize;
  const aligned = LENGTH_FIELD + 1 + payload.length - aadLength;
  let paddingLength = blockSize - (aligned % blockSize);
  if (paddingLength < SSH_MIN_PADDING) paddingLength += blockSize;
  const padding = cipher === NONE_CIPHER ? new Uint8Array(paddingLength) : random(paddingLength);
  const packet = concat(uint32(1 + payload.length + paddingLength), new Uint8Array([paddingLength]), payload, padding);
  const plainMac = mac !== null && !mac.etm ? mac.compute(seq, packet) : null;
  const sealed = cipher.crypt(seq, packet, aadLength, true)!;
  if (mac === null) return sealed;
  return concat(sealed, plainMac ?? mac.compute(seq, sealed));
}

export type PacketReadResult =
  | { readonly kind: 'packet'; readonly payload: Uint8Array }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'corrupt'; readonly log: string; readonly disconnect: string | null; readonly error: string };

const PACKET_CORRUPT = 'Packet corrupt';
const MAC_INVALID = 'message authentication code incorrect';
const CONNECTION_CORRUPTED = 'connection corrupted';
const CORRUPTED_MAC = 'Corrupted MAC on input.';

export class PacketReader {
  private buffer = new Uint8Array(0);
  private firstBlock: Uint8Array | null = null;
  private packetLength: number | null = null;

  push(bytes: Uint8Array): void {
    this.buffer = concat(this.buffer, bytes);
  }

  get pending(): number {
    return this.buffer.length;
  }

  take(count: number): Uint8Array {
    const head = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    return head;
  }

  read(protection: PacketProtection, seq: number): PacketReadResult {
    const { cipher, mac } = protection;
    const aadLength = aadLengthOf(protection);
    const blockSize = cipher.blockSize;
    if (this.packetLength === null) {
      if (aadLength > 0) {
        if (this.buffer.length < LENGTH_FIELD) return { kind: 'incomplete' };
        this.packetLength = cipher.length(seq, this.buffer.subarray(0, LENGTH_FIELD));
      } else {
        if (this.buffer.length < blockSize) return { kind: 'incomplete' };
        this.firstBlock = cipher.crypt(seq, this.buffer.subarray(0, blockSize), 0, false)!;
        this.packetLength = readUint32(this.firstBlock, 0);
      }
      if (this.packetLength < 1 + SSH_MIN_PADDING || this.packetLength > SSH_PACKET_MAX_SIZE) {
        return {
          kind: 'corrupt', log: `Bad packet length ${this.packetLength}.`,
          disconnect: PACKET_CORRUPT, error: aadLength > 0 ? CONNECTION_CORRUPTED : MAC_INVALID,
        };
      }
      const encrypted = aadLength > 0 ? this.packetLength : LENGTH_FIELD + this.packetLength;
      if (encrypted % blockSize !== 0) {
        const need = aadLength > 0 ? this.packetLength : encrypted - blockSize;
        return {
          kind: 'corrupt', log: `padding error: need ${need} block ${blockSize} mod ${need % blockSize}`,
          disconnect: PACKET_CORRUPT, error: MAC_INVALID,
        };
      }
    }
    const packetLength = this.packetLength;
    const macLength = mac?.length ?? 0;
    const total = LENGTH_FIELD + packetLength + cipher.authLength + macLength;
    if (this.buffer.length < total) return { kind: 'incomplete' };
    const sealed = this.buffer.slice(0, LENGTH_FIELD + packetLength + cipher.authLength);
    const receivedMac = this.buffer.slice(sealed.length, total);
    this.buffer = this.buffer.slice(total);
    const firstBlock = this.firstBlock;
    this.packetLength = null;
    this.firstBlock = null;
    if (mac !== null && mac.etm && !sameBytes(mac.compute(seq, sealed), receivedMac)) {
      return { kind: 'corrupt', log: CORRUPTED_MAC, disconnect: null, error: MAC_INVALID };
    }
    let packet: Uint8Array | null;
    if (firstBlock !== null) {
      const rest = cipher.crypt(seq, sealed.subarray(firstBlock.length), 0, false)!;
      packet = concat(firstBlock, rest);
    } else {
      packet = cipher.crypt(seq, sealed, aadLength, false);
    }
    if (packet === null) return { kind: 'corrupt', log: '', disconnect: null, error: MAC_INVALID };
    if (mac !== null && !mac.etm && !sameBytes(mac.compute(seq, packet), receivedMac)) {
      return { kind: 'corrupt', log: CORRUPTED_MAC, disconnect: PACKET_CORRUPT, error: MAC_INVALID };
    }
    const paddingLength = packet[LENGTH_FIELD];
    if (paddingLength < SSH_MIN_PADDING || paddingLength + 1 > packetLength) {
      return {
        kind: 'corrupt', log: '', disconnect: `Corrupted padlen ${paddingLength} on input.`, error: CONNECTION_CORRUPTED,
      };
    }
    return { kind: 'packet', payload: packet.slice(LENGTH_FIELD + 1, LENGTH_FIELD + packetLength - paddingLength) };
  }
}
