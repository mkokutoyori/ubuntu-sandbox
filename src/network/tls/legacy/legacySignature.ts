import { rsaSign, rsaVerify, materialToPrivateKey, materialToPublicKey } from '@/crypto/rsa';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';
import { PkiKeyPair, type PkiPrivateKey, type PkiPublicKey } from '@/network/pki/PkiKeyPair';
import type { LegacyVersion } from './legacyCipherSuites';

export function signatureAlgorithmName(algorithm: 'rsa' | 'ecdsa', version: LegacyVersion): string {
  if (algorithm === 'ecdsa') return 'ecdsa_secp256r1_sha256';
  return version === '1.2' ? 'rsa_pkcs1_sha256' : 'rsa_md5_sha1';
}

export function signLegacy(privateKey: PkiPrivateKey, version: LegacyVersion, data: Uint8Array): string {
  if (privateKey.algorithm === 'ecdsa') return PkiKeyPair.sign(privateKey, bytesToHex(data));
  const key = materialToPrivateKey(privateKey.material);
  if (key === null) return PkiKeyPair.sign(privateKey, bytesToHex(data));
  return bytesToHex(rsaSign(key, data, version === '1.2' ? 'sha256' : 'md5sha1'));
}

export function verifyLegacy(
  publicKey: PkiPublicKey, version: LegacyVersion, data: Uint8Array, signature: string,
): boolean {
  if (publicKey.algorithm === 'ecdsa') return PkiKeyPair.verify(publicKey, bytesToHex(data), signature);
  const key = materialToPublicKey(publicKey.material);
  if (key === null) return PkiKeyPair.verify(publicKey, bytesToHex(data), signature);
  if (!/^[0-9a-f]+$/i.test(signature) || signature.length % 2 !== 0) return false;
  return rsaVerify(key, data, hexToBytes(signature), version === '1.2' ? 'sha256' : 'md5sha1');
}
