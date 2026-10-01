import { IPAddress, IPv6Address } from '@/network/core/types';
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

interface PresentedIdentity {
  readonly type: 'dns' | 'ip';
  readonly value: string;
}

function presentedIdentities(cert: X509Certificate): PresentedIdentity[] {
  const identities: PresentedIdentity[] = [];
  for (const raw of cert.extensions?.subjectAltName ?? []) {
    const typed = /^\s*(DNS|IP|URI|email)\s*:\s*(.*?)\s*$/i.exec(raw);
    if (typed) {
      const kind = typed[1].toLowerCase();
      if (kind === 'dns') identities.push({ type: 'dns', value: typed[2] });
      else if (kind === 'ip') identities.push({ type: 'ip', value: typed[2] });
      continue;
    }
    const bare = raw.trim();
    identities.push({ type: IPAddress.tryParse(bare) || IPv6Address.tryParse(bare) ? 'ip' : 'dns', value: bare });
  }
  return identities;
}

function normalizedAddress(text: string): string | null {
  const v4 = IPAddress.tryParse(text);
  if (v4) return v4.toString();
  const v6 = IPv6Address.tryParse(text);
  return v6 ? v6.toString() : null;
}

function dnsIdentityMatches(presented: string, reference: string): boolean {
  const name = presented.toLowerCase().replace(/\.$/, '');
  if (!name.includes('*')) return name === reference;
  const labels = name.split('.');
  if (labels[0] !== '*' || labels.slice(1).some((label) => label.includes('*'))) return false;
  if (labels.length < 3) return false;
  const suffix = labels.slice(1).join('.');
  const referenceLabels = reference.split('.');
  return referenceLabels.length === labels.length && referenceLabels.slice(1).join('.') === suffix
    && referenceLabels[0].length > 0;
}

export function certificateMatchesHostname(cert: X509Certificate, hostname: string): boolean {
  const identities = presentedIdentities(cert);
  const address = normalizedAddress(hostname.replace(/^\[|\]$/g, ''));
  if (address !== null) {
    if (identities.length === 0) {
      const cn = /CN\s*=\s*([^,]+)/.exec(cert.subject);
      return cn !== null && normalizedAddress(cn[1].trim()) === address;
    }
    return identities.some((id) => id.type === 'ip' && normalizedAddress(id.value) === address);
  }
  const reference = hostname.toLowerCase().replace(/\.$/, '');
  const dnsIdentities = identities.filter((id) => id.type === 'dns').map((id) => id.value);
  if (dnsIdentities.length === 0) {
    const cn = /CN\s*=\s*([^,]+)/.exec(cert.subject);
    if (cn) dnsIdentities.push(cn[1].trim());
  }
  return dnsIdentities.some((presented) => dnsIdentityMatches(presented, reference));
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
