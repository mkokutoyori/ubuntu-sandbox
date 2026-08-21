import { PkiKeyPair } from './PkiKeyPair';
import type { X509Certificate } from './X509Certificate';
import { tbsPayload } from './X509Certificate';
import type { CertificateRevocationList } from './CertificateRevocationList';
import type { IOcspResponder } from './OcspResponder';

export type VerificationReason = 'unknown' | 'expired' | 'revoked' | 'not-yet-valid' | 'bad-signature' | 'crl-stale' | 'crl-untrusted' | 'hostname-mismatch';

export interface VerificationOk { readonly ok: true; readonly reason?: undefined }
export interface VerificationFailure { readonly ok: false; readonly reason: VerificationReason }
export type VerificationResult = VerificationOk | VerificationFailure;

export type RevocationCheckMode = 'none' | 'crl' | 'crl-strict' | 'ocsp';

export interface CertificateVerifierOptions {
  readonly trustAnchors: readonly X509Certificate[];
  readonly crls?: readonly CertificateRevocationList[];
  readonly revocationCheck?: RevocationCheckMode;
  readonly clock?: () => number;
  readonly ocspResponder?: IOcspResponder;
}

export class CertificateVerifier {
  private readonly trustAnchors: readonly X509Certificate[];
  private readonly crls: readonly CertificateRevocationList[];
  private readonly revocationCheck: RevocationCheckMode;
  private readonly clock: () => number;
  private readonly ocspResponder?: IOcspResponder;

  constructor(opts: CertificateVerifierOptions) {
    this.trustAnchors = opts.trustAnchors;
    this.crls = opts.crls ?? [];
    this.revocationCheck = opts.revocationCheck ?? 'none';
    this.clock = opts.clock ?? Date.now;
    this.ocspResponder = opts.ocspResponder;
  }

  verify(cert: X509Certificate, expectedHostname?: string): VerificationResult {
    const now = this.clock();
    const issuer = this.trustAnchors.find(a => a.subject === cert.issuer);
    if (!issuer) return { ok: false, reason: 'unknown' };
    if (!PkiKeyPair.verify(issuer.publicKey, tbsPayload(dropSignature(cert)), cert.signature)) {
      return { ok: false, reason: 'bad-signature' };
    }
    if (now < cert.notBefore) return { ok: false, reason: 'not-yet-valid' };
    if (now > cert.notAfter) return { ok: false, reason: 'expired' };
    if (expectedHostname && !certificateMatchesHostname(cert, expectedHostname)) {
      return { ok: false, reason: 'hostname-mismatch' };
    }
    if (this.revocationCheck === 'ocsp') {
      if (!this.ocspResponder) return { ok: false, reason: 'crl-stale' };
      const resp = this.ocspResponder.check(cert, now);
      if (resp.status === 'revoked') return { ok: false, reason: 'revoked' };
      if (resp.status === 'unknown') return { ok: false, reason: 'unknown' };
      return { ok: true };
    }
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

export function certificateMatchesHostname(cert: X509Certificate, hostname: string): boolean {
  const target = hostname.toLowerCase();
  const names: string[] = [...(cert.extensions?.subjectAltName ?? [])]
    // `subjectAltName=DNS:lab.local` / `IP:10.0.0.1` — openssl's own
    // spelling on the command line, and what this simulator stores, so the
    // type prefix has to come off before comparing against a hostname.
    .map((n) => n.replace(/^\s*(?:DNS|IP|URI|email)\s*:\s*/i, '').trim());
  if (names.length === 0) {
    // RFC 4514 allows whitespace around the `=`, and openssl PRINTS it that
    // way (`subject=C = FR, CN = www.lab`) — which is how this simulator's
    // own `openssl req` renders it. Requiring a bare `CN=` meant no
    // certificate issued here could ever match a hostname by its common
    // name; only a SAN worked, and only by accident.
    const cn = /CN\s*=\s*([^,]+)/.exec(cert.subject);
    if (cn) names.push(cn[1].trim());
  }
  return names.some(raw => {
    const name = raw.toLowerCase();
    if (name === target) return true;
    if (name.startsWith('*.')) {
      const suffix = name.slice(1);
      return target.endsWith(suffix) && !target.slice(0, -suffix.length).includes('.');
    }
    return false;
  });
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
