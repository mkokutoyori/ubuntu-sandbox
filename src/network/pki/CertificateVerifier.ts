import { PkiKeyPair } from './PkiKeyPair';
import type { X509Certificate } from './X509Certificate';
import { tbsPayload } from './X509Certificate';
import type { CertificateRevocationList } from './CertificateRevocationList';

export type VerificationReason = 'unknown' | 'expired' | 'revoked' | 'not-yet-valid' | 'bad-signature' | 'crl-stale' | 'crl-untrusted';

export interface VerificationOk { readonly ok: true }
export interface VerificationFailure { readonly ok: false; readonly reason: VerificationReason }
export type VerificationResult = VerificationOk | VerificationFailure;

export type RevocationCheckMode = 'none' | 'crl' | 'crl-strict';

export interface CertificateVerifierOptions {
  readonly trustAnchors: readonly X509Certificate[];
  readonly crls?: readonly CertificateRevocationList[];
  readonly revocationCheck?: RevocationCheckMode;
  readonly clock?: () => number;
}

export class CertificateVerifier {
  private readonly trustAnchors: readonly X509Certificate[];
  private readonly crls: readonly CertificateRevocationList[];
  private readonly revocationCheck: RevocationCheckMode;
  private readonly clock: () => number;

  constructor(opts: CertificateVerifierOptions) {
    this.trustAnchors = opts.trustAnchors;
    this.crls = opts.crls ?? [];
    this.revocationCheck = opts.revocationCheck ?? 'none';
    this.clock = opts.clock ?? Date.now;
  }

  verify(cert: X509Certificate): VerificationResult {
    const now = this.clock();
    const issuer = this.trustAnchors.find(a => a.subject === cert.issuer);
    if (!issuer) return { ok: false, reason: 'unknown' };
    if (!PkiKeyPair.verify(issuer.publicKey, tbsPayload(dropSignature(cert)), cert.signature)) {
      return { ok: false, reason: 'bad-signature' };
    }
    if (now < cert.notBefore) return { ok: false, reason: 'not-yet-valid' };
    if (now > cert.notAfter) return { ok: false, reason: 'expired' };
    if (this.revocationCheck !== 'none') {
      const crl = this.crls.find(c => c.issuer === cert.issuer);
      if (!crl) {
        if (this.revocationCheck === 'crl-strict') return { ok: false, reason: 'crl-stale' };
      } else {
        if (!crl.isValidSignature(issuer.publicKey)) return { ok: false, reason: 'crl-untrusted' };
        if (!crl.isFresh(now)) {
          if (this.revocationCheck === 'crl-strict') return { ok: false, reason: 'crl-stale' };
        }
        if (crl.contains(cert.serialNumber)) return { ok: false, reason: 'revoked' };
      }
    }
    return { ok: true };
  }
}

function dropSignature(cert: X509Certificate): X509Certificate {
  return {
    version: cert.version,
    serialNumber: cert.serialNumber,
    subject: cert.subject,
    issuer: cert.issuer,
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
    publicKey: cert.publicKey,
    signatureAlgorithm: cert.signatureAlgorithm,
    extensions: cert.extensions,
    signature: '',
  };
}
