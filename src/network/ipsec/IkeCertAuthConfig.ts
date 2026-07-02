import type { X509Certificate } from '../pki/X509Certificate';
import type { PkiPrivateKey } from '../pki/PkiKeyPair';
import type { CertificateRevocationList } from '../pki/CertificateRevocationList';
import type { CertificateVerifier, RevocationCheckMode, VerificationResult, VerificationFailure } from '../pki/CertificateVerifier';

export interface IkeCertAuthConfig {
  readonly localCert: X509Certificate;
  readonly localKey: PkiPrivateKey;
  readonly trustAnchors: readonly X509Certificate[];
  readonly crls?: readonly CertificateRevocationList[];
  readonly revocationCheck?: RevocationCheckMode;
  readonly clock?: () => number;
  readonly verifier: CertificateVerifier;
}

export function verificationToIkeReason(res: VerificationResult): string {
  if (res.ok) return '';
  switch ((res as VerificationFailure).reason) {
    case 'unknown': return 'Certificate unknown';
    case 'expired': return 'Certificate expired';
    case 'revoked': return 'Certificate revoked';
    case 'not-yet-valid': return 'Certificate not yet valid';
    case 'bad-signature': return 'Certificate signature invalid';
    case 'crl-stale': return 'CRL stale';
    case 'crl-untrusted': return 'CRL signature invalid';
  }
}
