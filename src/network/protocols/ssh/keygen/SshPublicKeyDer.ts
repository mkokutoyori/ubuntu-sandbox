import { bytesToBase64, base64ToBytes } from '@/crypto/encoding';
import { bitLength } from '@/crypto/rsa/rsa';
import { der, children, parseDer, integerValue, oidValue, bitStringBytes, unsignedIntegerBytes } from '@/network/pki/der/Asn1';
import { OID } from '@/network/pki/der/X509Der';
import {
  ecdsaCurveOf,
  isEcdsaKey,
  type EcdsaAlgorithm,
  type SshPublicKey,
} from '@/network/devices/linux/network/SshKeygenMaterial';

const ED25519_OID = '1.3.101.112';

const CURVE_OIDS: Readonly<Record<EcdsaAlgorithm, string>> = {
  'ecdsa-sha2-nistp256': OID.prime256v1,
  'ecdsa-sha2-nistp384': '1.3.132.0.34',
  'ecdsa-sha2-nistp521': '1.3.132.0.35',
};

function bigToMagnitude(value: bigint): Uint8Array {
  const hex = value.toString(16);
  const padded = hex.length % 2 === 1 ? `0${hex}` : hex;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function rsaPublicKeyPkcs1(key: Extract<SshPublicKey, { algorithm: 'ssh-rsa' }>): Uint8Array {
  return der.sequence(unsignedIntegerBytes(bigToMagnitude(key.n)), unsignedIntegerBytes(bigToMagnitude(key.e)));
}

export function publicKeySpki(key: SshPublicKey): Uint8Array {
  if (key.algorithm === 'ssh-rsa') {
    return der.sequence(der.sequence(der.oid(OID.rsaEncryption), der.null()), der.bitString(rsaPublicKeyPkcs1(key)));
  }
  if (isEcdsaKey(key)) {
    return der.sequence(der.sequence(der.oid(OID.ecPublicKey), der.oid(CURVE_OIDS[key.algorithm])), der.bitString(key.q));
  }
  return der.sequence(der.sequence(der.oid(ED25519_OID)), der.bitString(key.publicKey));
}

export function publicKeyFromSpki(bytes: Uint8Array): SshPublicKey | null {
  try {
    const [algorithm, bits] = children(parseDer(bytes));
    const algorithmParts = children(algorithm);
    const oid = oidValue(algorithmParts[0]);
    const body = bitStringBytes(bits).bytes;
    if (oid === OID.rsaEncryption) return publicKeyFromPkcs1(body);
    if (oid === ED25519_OID) return body.length === 32 ? { algorithm: 'ssh-ed25519', publicKey: body } : null;
    if (oid === OID.ecPublicKey) {
      const curve = oidValue(algorithmParts[1]);
      const named = (Object.keys(CURVE_OIDS) as EcdsaAlgorithm[]).find((name) => CURVE_OIDS[name] === curve);
      if (named === undefined || ecdsaCurveOf(named).decodePoint(body) === null) return null;
      return { algorithm: named, q: body };
    }
    return null;
  } catch {
    return null;
  }
}

export function publicKeyFromPkcs1(bytes: Uint8Array): SshPublicKey | null {
  try {
    const [modulus, exponent] = children(parseDer(bytes));
    return { algorithm: 'ssh-rsa', n: integerValue(modulus), e: integerValue(exponent) };
  } catch {
    return null;
  }
}

export function pemArmour(label: string, body: Uint8Array): string {
  const encoded = bytesToBase64(body);
  const lines: string[] = [];
  for (let at = 0; at < encoded.length; at += 64) lines.push(encoded.slice(at, at + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

export function pemBody(text: string, label: string): Uint8Array | null {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(text);
  if (match === null) return null;
  try {
    return base64ToBytes(match[1].replace(/\s+/g, ''));
  } catch {
    return null;
  }
}

export function rsaModulusBits(key: Extract<SshPublicKey, { algorithm: 'ssh-rsa' }>): number {
  return bitLength(key.n);
}
