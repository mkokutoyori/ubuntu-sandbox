import { bytesToHex, hexToBytes } from '@/crypto/encoding';
import { modInverse, modPow } from '@/crypto/rsa/rsa';
import type { PkiPrivateKey, PkiPublicKey } from '../PkiKeyPair';
import { der, children, parseDer, integerMagnitude, integerValue, oidValue, unsignedIntegerBytes, bitStringBytes, contextTag, DerError } from './Asn1';
import { OID, encodeSubjectPublicKeyInfo, decodeSubjectPublicKeyInfo } from './X509Der';

function bytesToBig(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigToBytes(value: bigint): Uint8Array {
  if (value === 0n) return Uint8Array.of(0);
  return hexToBytes(value.toString(16).padStart(Math.ceil(value.toString(16).length / 2) * 2, '0'));
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) { [x, y] = [y, x % y]; }
  return x;
}

export function recoverRsaPrimes(n: bigint, e: bigint, d: bigint): { p: bigint; q: bigint } {
  const k = e * d - 1n;
  let t = k;
  let s = 0;
  while ((t & 1n) === 0n) { t >>= 1n; s++; }
  for (let g = 2n; g < 200n; g++) {
    let y = modPow(g, t, n);
    if (y === 1n || y === n - 1n) continue;
    for (let i = 1; i <= s; i++) {
      const z = (y * y) % n;
      if (z === 1n) {
        const p = gcd(y - 1n, n);
        if (p !== 1n && p !== n) return { p: p > n / p ? p : n / p, q: p > n / p ? n / p : p };
        break;
      }
      if (z === n - 1n) break;
      y = z;
    }
  }
  throw new DerError('cannot recover the RSA primes from n, e and d');
}

function rsaParts(material: string): { n: bigint; e: bigint; d: bigint } {
  const parts = material.split(':');
  if (parts[0] !== 'rsa-priv' || parts.length < 4) throw new DerError('not an RSA private key');
  return { n: bytesToBig(hexToBytes(parts[1])), e: BigInt(`0x${parts[2]}`), d: bytesToBig(hexToBytes(parts[3])) };
}

function integerOf(value: bigint): Uint8Array {
  return unsignedIntegerBytes(bigToBytes(value));
}

export function encodeRsaPrivateKeyPkcs1(material: string): Uint8Array {
  const { n, e, d } = rsaParts(material);
  const { p, q } = recoverRsaPrimes(n, e, d);
  return der.sequence(
    der.integer(0n), integerOf(n), integerOf(e), integerOf(d), integerOf(p), integerOf(q),
    integerOf(d % (p - 1n)), integerOf(d % (q - 1n)), integerOf(modInverse(q, p)),
  );
}

export function decodeRsaPrivateKeyPkcs1(bytes: Uint8Array): PkiPrivateKey {
  const fields = children(parseDer(bytes));
  const n = bytesToBig(integerMagnitude(fields[1]));
  const e = integerValue(fields[2]);
  const d = bytesToBig(integerMagnitude(fields[3]));
  const width = Math.ceil(n.toString(16).length / 2);
  const pad = (value: bigint): string => value.toString(16).padStart(width * 2, '0');
  return { algorithm: 'rsa', material: `rsa-priv:${pad(n)}:${e.toString(16)}:${pad(d)}` };
}

const P256_OID_ENCODED = (): Uint8Array => der.oid(OID.prime256v1);

export function encodeEcPrivateKeySec1(material: string): Uint8Array {
  const [, d, point] = material.split(':');
  if (!d || !point) throw new DerError('not an EC private key');
  return der.sequence(
    der.integer(1n), der.octetString(hexToBytes(d)),
    der.explicit(0, P256_OID_ENCODED()),
    der.explicit(1, der.bitString(hexToBytes(point))),
  );
}

export function decodeEcPrivateKeySec1(bytes: Uint8Array): PkiPrivateKey {
  const fields = children(parseDer(bytes));
  const d = bytesToHex(fields[1].content);
  const publicField = fields.find((field) => field.tag === contextTag(1, true));
  if (!publicField) throw new DerError('EC private key without public point');
  const point = bytesToHex(bitStringBytes(children(publicField)[0]).bytes);
  return { algorithm: 'ecdsa', material: `ec-priv:${d}:${point}` };
}

export function encodePrivateKeyPkcs8(key: PkiPrivateKey): Uint8Array {
  if (key.algorithm === 'rsa') {
    return der.sequence(der.integer(0n), der.sequence(der.oid(OID.rsaEncryption), der.null()), der.octetString(encodeRsaPrivateKeyPkcs1(key.material)));
  }
  return der.sequence(der.integer(0n), der.sequence(der.oid(OID.ecPublicKey), P256_OID_ENCODED()), der.octetString(encodeEcPrivateKeySec1(key.material)));
}

export function decodePrivateKeyPkcs8(bytes: Uint8Array): PkiPrivateKey {
  const [, algorithm, body] = children(parseDer(bytes));
  const oid = oidValue(children(algorithm)[0]);
  if (oid === OID.rsaEncryption) return decodeRsaPrivateKeyPkcs1(body.content);
  if (oid === OID.ecPublicKey) return decodeEcPrivateKeySec1(body.content);
  throw new DerError(`unsupported key algorithm ${oid}`);
}

export function encodePublicKeySpki(key: PkiPublicKey): Uint8Array {
  return encodeSubjectPublicKeyInfo(key);
}

export function decodePublicKeySpki(bytes: Uint8Array): PkiPublicKey {
  return decodeSubjectPublicKeyInfo(parseDer(bytes));
}

