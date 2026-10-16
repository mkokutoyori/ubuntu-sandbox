import type { SshPrivateKey } from '@/network/devices/linux/network/SshKeygenMaterial';
import { sshPublicKeyBlob } from '@/network/devices/linux/network/SshKeygenMaterial';
import { signWithAlgorithm, verifyUserauthSignature } from '../auth/UserauthSignature';
import { parseCertificateBlob, plainAlgorithmOf, verifyCertificateSignature } from './SshCertificate';

export function signHostKeyExchange(key: SshPrivateKey, negotiatedAlgorithm: string, data: Uint8Array): Uint8Array {
  return signWithAlgorithm(key, plainAlgorithmOf(negotiatedAlgorithm) ?? negotiatedAlgorithm, data);
}

export function verifyHostKeyExchange(
  hostKeyBlob: Uint8Array, negotiatedAlgorithm: string, signature: Uint8Array, data: Uint8Array,
): boolean {
  const certificate = parseCertificateBlob(hostKeyBlob);
  if (certificate === null) return verifyUserauthSignature(hostKeyBlob, negotiatedAlgorithm, signature, data);
  const plain = plainAlgorithmOf(negotiatedAlgorithm);
  if (plain === null || !verifyCertificateSignature(certificate)) return false;
  return verifyUserauthSignature(sshPublicKeyBlob(certificate.subject), plain, signature, data);
}
