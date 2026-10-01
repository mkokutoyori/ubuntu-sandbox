import { IPAddress, IPv6Address } from '@/network/core/types';
import { PkiKeyPair } from './PkiKeyPair';
import { modulusHex } from '@/crypto/rsa';
import type { X509Certificate } from './X509Certificate';
import { tbsPayload } from './X509Certificate';
import type { CertificateRevocationList } from './CertificateRevocationList';
import type { IOcspResponder } from './OcspResponder';

export type VerificationReason =
  | 'unknown' | 'expired' | 'revoked' | 'not-yet-valid' | 'bad-signature' | 'crl-stale' | 'crl-untrusted'
  | 'hostname-mismatch' | 'not-a-ca' | 'path-length' | 'key-usage' | 'purpose' | 'weak-key';

export type CertificatePurpose = 'serverAuth' | 'clientAuth';

const MAX_CHAIN_DEPTH = 10;

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
  readonly minRsaBits?: number;
}

export class CertificateVerifier {
  private readonly trustAnchors: readonly X509Certificate[];
  private readonly crls: readonly CertificateRevocationList[];
  private readonly revocationCheck: RevocationCheckMode;
  private readonly clock: () => number;
  private readonly ocspResponder?: IOcspResponder;
  private readonly minRsaBits: number;

  constructor(opts: CertificateVerifierOptions) {
    this.trustAnchors = opts.trustAnchors;
    this.crls = opts.crls ?? [];
    this.revocationCheck = opts.revocationCheck ?? 'none';
    this.clock = opts.clock ?? Date.now;
    this.ocspResponder = opts.ocspResponder;
    this.minRsaBits = opts.minRsaBits ?? 0;
  }

  verify(
    cert: X509Certificate, expectedHostname?: string,
    intermediates: readonly X509Certificate[] = [], purpose?: CertificatePurpose,
  ): VerificationResult {
    const now = this.clock();
    const path = this.buildPath(cert, intermediates);
    if (path.ok === false) return path;
    const issuer = path.anchor;
    const failure = this.checkPath(cert, path.intermediates, now, purpose);
    if (failure) return failure;
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

  private buildPath(cert: X509Certificate, intermediates: readonly X509Certificate[]): PathResult {
    const used: X509Certificate[] = [];
    let current = cert;
    for (let depth = 0; depth <= MAX_CHAIN_DEPTH; depth++) {
      const anchor = this.trustAnchors.find((a) => a.subject === current.issuer);
      if (anchor) {
        if (!PkiKeyPair.verify(anchor.publicKey, tbsPayload(dropSignature(current)), current.signature)) {
          return { ok: false, reason: 'bad-signature' };
        }
        return { ok: true, anchor, intermediates: used };
      }
      const next = intermediates.find((candidate) => candidate.subject === current.issuer
        && !used.includes(candidate)
        && PkiKeyPair.verify(candidate.publicKey, tbsPayload(dropSignature(current)), current.signature));
      if (!next) {
        const forged = intermediates.some((candidate) => candidate.subject === current.issuer);
        return { ok: false, reason: forged ? 'bad-signature' : 'unknown' };
      }
      used.push(next);
      current = next;
    }
    return { ok: false, reason: 'path-length' };
  }

  private checkPath(
    leaf: X509Certificate, intermediates: readonly X509Certificate[], now: number, purpose?: CertificatePurpose,
  ): VerificationFailure | null {
    for (let index = 0; index < intermediates.length; index++) {
      const ca = intermediates[index];
      if (now < ca.notBefore) return { ok: false, reason: 'not-yet-valid' };
      if (now > ca.notAfter) return { ok: false, reason: 'expired' };
      const constraints = ca.extensions?.basicConstraints;
      if (!constraints || constraints.cA !== true) return { ok: false, reason: 'not-a-ca' };
      const usage = ca.extensions?.keyUsage;
      if (usage && !usage.includes('keyCertSign')) return { ok: false, reason: 'key-usage' };
      const below = intermediates.slice(0, index).filter((c) => c.subject !== c.issuer).length;
      if (constraints.pathLenConstraint !== undefined && below > constraints.pathLenConstraint) {
        return { ok: false, reason: 'path-length' };
      }
      if (this.weakKey(ca)) return { ok: false, reason: 'weak-key' };
    }
    if (purpose) {
      const eku = leaf.extensions?.extKeyUsage;
      if (eku && eku.length > 0 && !eku.includes(purpose) && !eku.includes('anyExtendedKeyUsage')) {
        return { ok: false, reason: 'purpose' };
      }
    }
    if (this.weakKey(leaf)) return { ok: false, reason: 'weak-key' };
    return null;
  }

  private weakKey(cert: X509Certificate): boolean {
    if (this.minRsaBits === 0 || cert.publicKey.algorithm !== 'rsa') return false;
    const bits = rsaBits(cert);
    return bits !== null && bits < this.minRsaBits;
  }
}

type PathResult =
  | { readonly ok: true; readonly anchor: X509Certificate; readonly intermediates: readonly X509Certificate[] }
  | VerificationFailure;

function rsaBits(cert: X509Certificate): number | null {
  const modulus = modulusHex(cert.publicKey.material);
  return modulus === null ? null : modulus.replace(/^0+/, '').length * 4;
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
