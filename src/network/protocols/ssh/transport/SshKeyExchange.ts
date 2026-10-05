import { SHA1 } from '@/crypto/hash/sha1';
import { SHA256 } from '@/crypto/hash/sha256';
import { SHA512 } from '@/crypto/hash/sha512';
import type { HashAlgorithm } from '@/crypto/hash/HashAlgorithm';
import { x25519, x25519Base, isAllZero, X25519_KEY_LEN } from '@/crypto/ecc/x25519';
import {
  generateP256PrivateScalar, p256Ecdh, p256PublicKey, isOnCurve, P256_FIELD_BYTES,
} from '@/crypto/ecc/p256';
import { modpGroup, type ModpGroup } from '@/crypto/dh/modp';
import { modPow } from '@/crypto/rsa/rsa';
import { SshReader, SshWriter } from '../wire/SshDataTypes';
import { SSH_MSG_KEXINIT } from './SshMessageNumbers';

export type RandomSource = (n: number) => Uint8Array;

export const systemRandom: RandomSource = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export type KexValueEncoding = 'string' | 'mpint';

export interface EphemeralKey {
  readonly publicKey: Uint8Array;
  sharedSecret(peerPublicKey: Uint8Array): bigint | null;
}

export interface KexMethod {
  readonly name: string;
  readonly hash: HashAlgorithm;
  readonly encoding: KexValueEncoding;
  generate(random: RandomSource, needBytes: number): EphemeralKey;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function bigIntToBytes(n: bigint): Uint8Array {
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function bigIntToFixed(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = n;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function popCount(n: bigint): number {
  let count = 0;
  for (let rest = n; rest > 0n; rest >>= 1n) if (rest & 1n) count++;
  return count;
}

const curve25519 = (name: string): KexMethod => ({
  name,
  hash: SHA256,
  encoding: 'string',
  generate(random) {
    const scalar = random(X25519_KEY_LEN);
    return {
      publicKey: x25519Base(scalar),
      sharedSecret(peer) {
        if (peer.length !== X25519_KEY_LEN) return null;
        const shared = x25519(scalar, peer);
        return isAllZero(shared) ? null : bytesToBigInt(shared);
      },
    };
  },
});

const UNCOMPRESSED_POINT = 0x04;

const ecdhNistp256: KexMethod = {
  name: 'ecdh-sha2-nistp256',
  hash: SHA256,
  encoding: 'string',
  generate(random) {
    const d = generateP256PrivateScalar(random);
    const q = p256PublicKey(d);
    const publicKey = new Uint8Array(1 + 2 * P256_FIELD_BYTES);
    publicKey[0] = UNCOMPRESSED_POINT;
    publicKey.set(bigIntToFixed(q.x, P256_FIELD_BYTES), 1);
    publicKey.set(bigIntToFixed(q.y, P256_FIELD_BYTES), 1 + P256_FIELD_BYTES);
    return {
      publicKey,
      sharedSecret(peer) {
        if (peer.length !== 1 + 2 * P256_FIELD_BYTES || peer[0] !== UNCOMPRESSED_POINT) return null;
        const point = {
          x: bytesToBigInt(peer.subarray(1, 1 + P256_FIELD_BYTES)),
          y: bytesToBigInt(peer.subarray(1 + P256_FIELD_BYTES)),
        };
        if (!isOnCurve(point)) return null;
        const shared = p256Ecdh(d, point);
        return shared === null ? null : bytesToBigInt(shared);
      },
    };
  },
};

const MIN_DH_PUBLIC_BITS_SET = 4;
const MIN_DH_NEED_BITS = 256;

function finiteFieldDh(name: string, hash: HashAlgorithm, groupId: number): KexMethod {
  return {
    name,
    hash,
    encoding: 'mpint',
    generate(random, needBytes) {
      const group = modpGroup(groupId) as ModpGroup;
      const pBits = group.prime.toString(2).length;
      const need = Math.max(needBytes * 8, MIN_DH_NEED_BITS);
      const exponentBits = Math.min(need * 2, pBits - 1);
      const raw = random(Math.ceil(exponentBits / 8));
      let x = bytesToBigInt(raw) & ((1n << BigInt(exponentBits)) - 1n);
      if (x < 2n) x += 2n;
      const e = modPow(group.generator, x, group.prime);
      return {
        publicKey: bigIntToBytes(e),
        sharedSecret(peer) {
          const f = bytesToBigInt(peer);
          if (f <= 1n || f >= group.prime - 1n || popCount(f) < MIN_DH_PUBLIC_BITS_SET) return null;
          return modPow(f, x, group.prime);
        },
      };
    },
  };
}

export const KEX_METHODS: readonly KexMethod[] = [
  curve25519('curve25519-sha256'),
  curve25519('curve25519-sha256@libssh.org'),
  ecdhNistp256,
  finiteFieldDh('diffie-hellman-group16-sha512', SHA512, 16),
  finiteFieldDh('diffie-hellman-group18-sha512', SHA512, 18),
  finiteFieldDh('diffie-hellman-group14-sha256', SHA256, 14),
  finiteFieldDh('diffie-hellman-group14-sha1', SHA1, 14),
  finiteFieldDh('diffie-hellman-group1-sha1', SHA1, 2),
];

export function kexMethod(name: string): KexMethod | null {
  return KEX_METHODS.find((m) => m.name === name) ?? null;
}

export function writeKexValue(writer: SshWriter, encoding: KexValueEncoding, value: Uint8Array): SshWriter {
  return encoding === 'string' ? writer.writeBytes(value) : writer.writeMpint(bytesToBigInt(value));
}

export function readKexValue(reader: SshReader, encoding: KexValueEncoding): Uint8Array {
  return encoding === 'string' ? reader.readBytes() : bigIntToBytes(reader.readMpint());
}

export interface ExchangeHashInput {
  readonly method: KexMethod;
  readonly clientIdentification: string;
  readonly serverIdentification: string;
  readonly clientKexInit: Uint8Array;
  readonly serverKexInit: Uint8Array;
  readonly hostKeyBlob: Uint8Array;
  readonly clientPublic: Uint8Array;
  readonly serverPublic: Uint8Array;
  readonly sharedSecret: bigint;
}

export function exchangeHash(input: ExchangeHashInput): Uint8Array {
  if (input.clientKexInit[0] !== SSH_MSG_KEXINIT || input.serverKexInit[0] !== SSH_MSG_KEXINIT) {
    throw new RangeError('ssh: exchange hash over a payload that is not a KEXINIT');
  }
  const writer = new SshWriter()
    .writeString(input.clientIdentification)
    .writeString(input.serverIdentification)
    .writeBytes(input.clientKexInit)
    .writeBytes(input.serverKexInit)
    .writeBytes(input.hostKeyBlob);
  writeKexValue(writer, input.method.encoding, input.clientPublic);
  writeKexValue(writer, input.method.encoding, input.serverPublic);
  return input.method.hash.digest(writer.writeMpint(input.sharedSecret).toBytes());
}

export type KeyLetter = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export function deriveKey(
  hash: HashAlgorithm, sharedSecret: bigint, exchangeHashValue: Uint8Array, letter: KeyLetter,
  sessionId: Uint8Array, length: number,
): Uint8Array {
  const secret = new SshWriter().writeMpint(sharedSecret).toBytes();
  let key = hash.digest(new SshWriter()
    .writeRaw(secret).writeRaw(exchangeHashValue).writeRaw(new Uint8Array([letter.charCodeAt(0)])).writeRaw(sessionId)
    .toBytes());
  while (key.length < length) {
    const next = hash.digest(new SshWriter().writeRaw(secret).writeRaw(exchangeHashValue).writeRaw(key).toBytes());
    const grown = new Uint8Array(key.length + next.length);
    grown.set(key);
    grown.set(next, key.length);
    key = grown;
  }
  return key.slice(0, length);
}
