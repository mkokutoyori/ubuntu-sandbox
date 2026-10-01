import { rsaSign, rsaVerify, materialToPrivateKey, materialToPublicKey } from '@/crypto/rsa';
import {
  p256Sign, p256Verify, materialToP256Private, materialToP256Public, signatureToHex, hexToSignature,
} from '@/crypto/ecc';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';
import { PkiKeyPair, type PkiPrivateKey, type PkiPublicKey } from '@/network/pki/PkiKeyPair';
import type { LegacyVersion } from './legacyCipherSuites';

export function signatureAlgorithmName(algorithm: 'rsa' | 'ecdsa', version: LegacyVersion): string {
  if (algorithm === 'ecdsa') return version === '1.2' ? 'ecdsa_secp256r1_sha256' : 'ecdsa_sha1';
  return version === '1.2' ? 'rsa_pkcs1_sha256' : 'rsa_md5_sha1';
}

export function signLegacy(privateKey: PkiPrivateKey, version: LegacyVersion, data: Uint8Array): string {
  if (privateKey.algorithm === 'ecdsa') {
    const d = materialToP256Private(privateKey.material);
    if (d === null) return PkiKeyPair.sign(privateKey, bytesToHex(data));
    return `ecdsa:${signatureToHex(p256Sign(d, data, version === '1.2' ? 'sha256' : 'sha1'))}`;
  }
  const key = materialToPrivateKey(privateKey.material);
  if (key === null) return PkiKeyPair.sign(privateKey, bytesToHex(data));
  return bytesToHex(rsaSign(key, data, version === '1.2' ? 'sha256' : 'md5sha1'));
}

export function verifyLegacy(
  publicKey: PkiPublicKey, version: LegacyVersion, data: Uint8Array, signature: string,
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
  return rsaVerify(key, data, hexToBytes(signature), version === '1.2' ? 'sha256' : 'md5sha1');
}
