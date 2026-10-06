import { rsaSign, rsaVerify, rsaPssSign, rsaPssVerify, materialToPrivateKey, materialToPublicKey } from '@/crypto/rsa';
import { SHA256 } from '@/crypto/hash';
import {
  p256Sign, p256Verify, materialToP256Private, materialToP256Public, signatureToHex, hexToSignature,
} from '@/crypto/ecc';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';
import { PkiKeyPair, type PkiPrivateKey, type PkiPublicKey } from '@/network/pki/PkiKeyPair';
import type { LegacyVersion } from './legacyCipherSuites';

const RSA_PSS_SCHEME = 'rsa_pss_rsae_sha256';
const PSS_SALT_LENGTH = 32;

const PSS_MINIMUM_MODULUS_BYTES = 2 + 32 + PSS_SALT_LENGTH;

function modulusBytes(key: PkiPrivateKey): number {
  const parsed = materialToPrivateKey(key.material);
  return parsed === null ? 0 : Math.ceil(parsed.n.toString(16).length / 2);
}

export function signatureAlgorithmName(
  key: PkiPrivateKey, version: LegacyVersion, peerOffered: readonly string[] = [],
): string {
  if (key.algorithm === 'ecdsa') return version === '1.2' ? 'ecdsa_secp256r1_sha256' : 'ecdsa_sha1';
  if (version !== '1.2') return 'rsa_md5_sha1';
  return peerOffered.includes(RSA_PSS_SCHEME) && modulusBytes(key) >= PSS_MINIMUM_MODULUS_BYTES ? RSA_PSS_SCHEME : 'rsa_pkcs1_sha256';
}

export function signLegacy(privateKey: PkiPrivateKey, version: LegacyVersion, data: Uint8Array, scheme?: string): string {
  if (privateKey.algorithm === 'ecdsa') {
    const d = materialToP256Private(privateKey.material);
    if (d === null) return PkiKeyPair.sign(privateKey, bytesToHex(data));
    return `ecdsa:${signatureToHex(p256Sign(d, data, version === '1.2' ? 'sha256' : 'sha1'))}`;
  }
  const key = materialToPrivateKey(privateKey.material);
  if (key === null) return PkiKeyPair.sign(privateKey, bytesToHex(data));
  if (scheme === RSA_PSS_SCHEME) return bytesToHex(rsaPssSign(key, data, SHA256, PSS_SALT_LENGTH));
  return bytesToHex(rsaSign(key, data, version === '1.2' ? 'sha256' : 'md5sha1'));
}

export function verifyLegacy(
  publicKey: PkiPublicKey, version: LegacyVersion, data: Uint8Array, signature: string, scheme?: string,
): boolean {
  if (publicKey.algorithm === 'ecdsa') {
    const q = materialToP256Public(publicKey.material);
    if (q === null) return PkiKeyPair.verify(publicKey, bytesToHex(data), signature);
    if (!signature.startsWith('ecdsa:')) return false;
    const parsed = hexToSignature(signature.slice(6));
    return parsed !== null && p256Verify(q, data, parsed, version === '1.2' ? 'sha256' : 'sha1');
  }
  const key = materialToPublicKey(publicKey.material);
  if (key === null) return PkiKeyPair.verify(publicKey, bytesToHex(data), signature);
  if (!/^[0-9a-f]+$/i.test(signature) || signature.length % 2 !== 0) return false;
  if (scheme === RSA_PSS_SCHEME) return rsaPssVerify(key, data, hexToBytes(signature), SHA256, PSS_SALT_LENGTH);
  return rsaVerify(key, data, hexToBytes(signature), version === '1.2' ? 'sha256' : 'md5sha1');
}
