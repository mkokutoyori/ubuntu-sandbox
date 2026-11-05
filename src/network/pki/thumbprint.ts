import type { X509Certificate } from './X509Certificate';
import { encodeCertificate } from './der/X509Der';
import { bytesToHex } from '@/crypto/encoding';
import { sha1 } from '@/crypto/hash';

export function certificateThumbprint(certificate: X509Certificate): string {
  return bytesToHex(sha1(encodeCertificate(certificate))).toUpperCase();
}
