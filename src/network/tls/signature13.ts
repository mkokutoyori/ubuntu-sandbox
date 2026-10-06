import { SHA256 } from '@/crypto/hash';
import { materialToPrivateKey, materialToPublicKey, rsaPssSign, rsaPssVerify } from '@/crypto/rsa';
import { bytesToHex, hexToBytes } from '@/crypto/encoding';
import { PkiKeyPair, type PkiPrivateKey, type PkiPublicKey } from '@/network/pki/PkiKeyPair';

export type Tls13SignatureScheme = 'rsa_pss_rsae_sha256' | 'ecdsa_secp256r1_sha256';

export const SUPPORTED_SIGNATURE_SCHEMES: readonly Tls13SignatureScheme[] = ['rsa_pss_rsae_sha256', 'ecdsa_secp256r1_sha256'];

export const CLIENT_HELLO_SIGNATURE_SCHEMES: readonly string[] = ['rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256', 'ecdsa_secp256r1_sha256'];

const PSS_SALT_LENGTH = 32;

export function schemeForKey(algorithm: 'rsa' | 'ecdsa'): Tls13SignatureScheme {
  return algorithm === 'rsa' ? 'rsa_pss_rsae_sha256' : 'ecdsa_secp256r1_sha256';
}

export function signCertificateVerify(
  privateKey: PkiPrivateKey, content: Uint8Array,
): { scheme: Tls13SignatureScheme; signature: string } | null {
  const scheme = schemeForKey(privateKey.algorithm);
  if (scheme === 'ecdsa_secp256r1_sha256') return { scheme, signature: PkiKeyPair.sign(privateKey, content) };
  const key = materialToPrivateKey(privateKey.material);
  if (key === null) return null;
  try {
    return { scheme, signature: bytesToHex(rsaPssSign(key, content, SHA256, PSS_SALT_LENGTH)) };
  } catch {
    return null;
  }
}

export function verifyCertificateVerify(
  publicKey: PkiPublicKey, content: Uint8Array, scheme: string | undefined, signature: string,
): boolean {
  if (scheme === undefined || scheme !== schemeForKey(publicKey.algorithm)) return false;
  if (scheme === 'ecdsa_secp256r1_sha256') return PkiKeyPair.verify(publicKey, content, signature);
  const key = materialToPublicKey(publicKey.material);
  if (key === null || !/^[0-9a-f]+$/i.test(signature) || signature.length % 2 !== 0) return false;
  return rsaPssVerify(key, content, hexToBytes(signature), SHA256, PSS_SALT_LENGTH);
}
