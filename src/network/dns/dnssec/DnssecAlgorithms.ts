import {
  generateRsaKeyPair, rsaSign, rsaVerify, type RsaPrivateKey, type RsaPublicKey, type RandomBytes,
  type RsaSignatureHash,
} from '@/crypto/rsa';
import { sha256 } from '@/crypto/hash';
import {
  p256PublicKey, p256Sign, p256Verify, P256_ORDER, type P256Point,
} from '@/crypto/ecc/p256';

export const DnssecAlgorithmNumber = {
  RSASHA1: 5,
  RSASHA256: 8,
  ECDSAP256SHA256: 13,
} as const;

const RSA_ZONE_KEY_BITS = 1024;
const P256_COORDINATE_BYTES = 32;

export interface DnssecPrivateKey {
  readonly algorithm: number;
  readonly material: bigint | RsaPrivateKey;
}

export interface GeneratedDnssecKey {
  readonly publicKey: Uint8Array;
  readonly privateKey: DnssecPrivateKey;
}

function bigToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function bytesToBig(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function seededRandom(seed: string): RandomBytes {
  let counter = 0;
  return (length) => {
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const block = sha256(new TextEncoder().encode(`${seed}|${counter++}`));
      const take = Math.min(block.length, length - filled);
      out.set(block.subarray(0, take), filled);
      filled += take;
    }
    return out;
  };
}

function rsaPublicWire(key: RsaPublicKey): Uint8Array {
  const exponent = bigToBytes(key.e, Math.ceil(key.e.toString(16).length / 2));
  const modulus = bigToBytes(key.n, Math.ceil(key.n.toString(16).length / 2));
  const header = exponent.length <= 255
    ? [exponent.length]
    : [0, (exponent.length >> 8) & 0xff, exponent.length & 0xff];
  return Uint8Array.from([...header, ...exponent, ...modulus]);
}

function rsaPublicFromWire(bytes: Uint8Array): RsaPublicKey | null {
  if (bytes.length < 3) return null;
  let offset = 1;
  let exponentLength = bytes[0];
  if (exponentLength === 0) {
    exponentLength = (bytes[1] << 8) | bytes[2];
    offset = 3;
  }
  if (offset + exponentLength >= bytes.length) return null;
  const exponent = bytes.subarray(offset, offset + exponentLength);
  const modulus = bytes.subarray(offset + exponentLength);
  return { n: bytesToBig(modulus), e: bytesToBig(exponent) };
}

function p256PublicWire(point: P256Point): Uint8Array {
  return Uint8Array.from([
    ...bigToBytes(point.x, P256_COORDINATE_BYTES), ...bigToBytes(point.y, P256_COORDINATE_BYTES),
  ]);
}

function p256PublicFromWire(bytes: Uint8Array): P256Point | null {
  if (bytes.length !== 2 * P256_COORDINATE_BYTES) return null;
  return {
    x: bytesToBig(bytes.subarray(0, P256_COORDINATE_BYTES)),
    y: bytesToBig(bytes.subarray(P256_COORDINATE_BYTES)),
  };
}

function rsaHashOf(algorithm: number): RsaSignatureHash | null {
  if (algorithm === DnssecAlgorithmNumber.RSASHA1) return 'sha1';
  if (algorithm === DnssecAlgorithmNumber.RSASHA256) return 'sha256';
  return null;
}

export function isSupportedAlgorithm(algorithm: number): boolean {
  return algorithm === DnssecAlgorithmNumber.ECDSAP256SHA256 || rsaHashOf(algorithm) !== null;
}

export function generateDnssecKey(algorithm: number, seed: string): GeneratedDnssecKey {
  if (algorithm === DnssecAlgorithmNumber.ECDSAP256SHA256) {
    const scalar = (bytesToBig(sha256(new TextEncoder().encode(`p256|${seed}`))) % (P256_ORDER - 1n)) + 1n;
    return {
      publicKey: p256PublicWire(p256PublicKey(scalar)),
      privateKey: { algorithm, material: scalar },
    };
  }
  if (rsaHashOf(algorithm) !== null) {
    const pair = generateRsaKeyPair(RSA_ZONE_KEY_BITS, seededRandom(`rsa|${seed}`));
    return { publicKey: rsaPublicWire(pair.publicKey), privateKey: { algorithm, material: pair.privateKey } };
  }
  throw new RangeError(`unsupported DNSSEC algorithm ${algorithm}`);
}

export function signWithDnssecKey(key: DnssecPrivateKey, data: Uint8Array): Uint8Array {
  if (key.algorithm === DnssecAlgorithmNumber.ECDSAP256SHA256) {
    const signature = p256Sign(key.material as bigint, data);
    return Uint8Array.from([
      ...bigToBytes(signature.r, P256_COORDINATE_BYTES), ...bigToBytes(signature.s, P256_COORDINATE_BYTES),
    ]);
  }
  const hash = rsaHashOf(key.algorithm);
  if (hash === null) throw new RangeError(`unsupported DNSSEC algorithm ${key.algorithm}`);
  return rsaSign(key.material as RsaPrivateKey, data, hash);
}

export function verifyWithDnssecKey(
  algorithm: number, publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array,
): boolean {
  if (algorithm === DnssecAlgorithmNumber.ECDSAP256SHA256) {
    const point = p256PublicFromWire(publicKey);
    if (point === null || signature.length !== 2 * P256_COORDINATE_BYTES) return false;
    return p256Verify(point, data, {
      r: bytesToBig(signature.subarray(0, P256_COORDINATE_BYTES)),
      s: bytesToBig(signature.subarray(P256_COORDINATE_BYTES)),
    });
  }
  const hash = rsaHashOf(algorithm);
  if (hash === null) return false;
  const key = rsaPublicFromWire(publicKey);
  return key !== null && rsaVerify(key, data, signature, hash);
}
