import type { VerificationReason } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { x509VerifyError } from '@/network/pki/x509VerifyErrors';

export function tlsVerifyFailureText(reason: VerificationReason, certificate: X509Certificate | null): string {
  if (reason === 'hostname-mismatch') return 'hostname mismatch';
  if (certificate === null) return 'unable to get local issuer certificate';
  return x509VerifyError(reason, certificate, []).texte;
}
