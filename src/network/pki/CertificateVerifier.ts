import { IPAddress, IPv6Address } from '@/network/core/types';
import { PkiKeyPair } from './PkiKeyPair';
import { keyPermitted } from '@/network/tls/legacy/securityPolicy';
import type { X509Certificate } from './X509Certificate';
import { tbsPayload } from './X509Certificate';
import type { CertificateRevocationList } from './CertificateRevocationList';
import { verifyOcspStaple, type IOcspResponder, type SignedOcspResponse, type OcspStapleVerdict } from './OcspResponder';

export type VerificationReason =
  | 'unknown' | 'expired' | 'revoked' | 'not-yet-valid' | 'bad-signature' | 'crl-stale' | 'crl-untrusted'
  | 'hostname-mismatch' | 'not-a-ca' | 'path-length' | 'chain-too-long' | 'key-usage' | 'purpose' | 'weak-key' | 'weak-ca-key';

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
  readonly securityLevel?: number;
  readonly maxDepth?: number;
  readonly revocationScope?: 'leaf' | 'chain';
  readonly missingCrlOk?: boolean;
  readonly crlMode?: 'crl' | 'crl-strict';
  readonly ocspScope?: 'leaf' | 'chain';
  readonly missingOcspOk?: boolean;
}

export class CertificateVerifier {
  private readonly trustAnchors: readonly X509Certificate[];
  private readonly crls: readonly CertificateRevocationList[];
  private readonly revocationCheck: RevocationCheckMode;
  private readonly clock: () => number;
  private readonly ocspResponder?: IOcspResponder;
  private readonly securityLevel: number;
  private readonly maxDepth: number | undefined;
  private readonly revocationScope: 'leaf' | 'chain';
  private readonly missingCrlOk: boolean;
  private readonly crlMode: 'crl' | 'crl-strict';
  private readonly ocspScope: 'leaf' | 'chain';
  private readonly missingOcspOk: boolean;

  constructor(opts: CertificateVerifierOptions) {
    this.trustAnchors = opts.trustAnchors;
    this.crls = opts.crls ?? [];
    this.revocationCheck = opts.revocationCheck ?? 'none';
    this.clock = opts.clock ?? Date.now;
    this.ocspResponder = opts.ocspResponder;
    this.securityLevel = opts.securityLevel ?? 0;
    this.maxDepth = opts.maxDepth;
    this.revocationScope = opts.revocationScope ?? 'chain';
    this.missingCrlOk = opts.missingCrlOk ?? false;
    this.crlMode = opts.crlMode ?? (this.revocationCheck === 'crl-strict' ? 'crl-strict' : 'crl');
    this.ocspScope = opts.ocspScope ?? 'leaf';
    this.missingOcspOk = opts.missingOcspOk ?? false;
  }

  verify(
    cert: X509Certificate, expectedHostname?: string,
    intermediates: readonly X509Certificate[] = [], purpose?: CertificatePurpose, securityLevel?: number,
  ): VerificationResult {
    const now = this.clock();
    const path = this.buildPath(cert, intermediates);
    if (path.ok === false) return path;
    const issuer = path.anchor;
    const level = securityLevel ?? this.securityLevel;
    const failure = this.checkPath(cert, path.intermediates, now, purpose, level)
      ?? (anchorIsLeaf(cert, issuer) || keyPermitted(level, issuer.publicKey) ? null : { ok: false as const, reason: 'weak-ca-key' as const });
    if (failure) return failure;
    if (now < cert.notBefore) return { ok: false, reason: 'not-yet-valid' };
    if (now > cert.notAfter) return { ok: false, reason: 'expired' };
    if (expectedHostname && !certificateMatchesHostname(cert, expectedHostname)) {
      return { ok: false, reason: 'hostname-mismatch' };
    }
    if (this.revocationCheck === 'ocsp') {
      if (!this.ocspResponder) return { ok: false, reason: 'crl-stale' };
      const members = this.ocspScope === 'leaf' || anchorIsLeaf(cert, issuer) ? [cert] : [cert, ...path.intermediates];
      for (const member of members) {
        const resp = this.ocspResponder.check(member, now);
        if (resp.status === 'revoked') return { ok: false, reason: 'revoked' };
        if (resp.status === 'unknown' && !this.missingOcspOk) return { ok: false, reason: 'unknown' };
      }
    }
    if (this.revocationCheck !== 'none' && (this.revocationCheck !== 'ocsp' || this.crls.length > 0)) {
      const members = anchorIsLeaf(cert, issuer) ? [cert] : [cert, ...path.intermediates, issuer];
      const issuers = anchorIsLeaf(cert, issuer) ? [issuer] : [...path.intermediates, issuer, issuer];
      const checked = this.revocationScope === 'leaf' ? 1 : members.length;
      for (let index = 0; index < checked; index++) {
        const failure = this.crlFailure(members[index], issuers[index], now);
        if (failure) return failure;
      }
    }
    return { ok: true };
  }

  private crlFailure(cert: X509Certificate, issuer: X509Certificate, now: number): VerificationFailure | null {
    const crl = this.crls.find((candidate) => candidate.issuer === cert.issuer);
    if (!crl) return this.crlMode === 'crl-strict' && !this.missingCrlOk ? { ok: false, reason: 'crl-stale' } : null;
    if (!crl.isValidSignature(issuer.publicKey)) return { ok: false, reason: 'crl-untrusted' };
    if (!crl.isFresh(now) && this.crlMode === 'crl-strict') return { ok: false, reason: 'crl-stale' };
    return crl.contains(cert.serialNumber) ? { ok: false, reason: 'revoked' } : null;
  }

  checkOcspStaple(
    cert: X509Certificate, intermediates: readonly X509Certificate[], staple: SignedOcspResponse,
  ): OcspStapleVerdict | { ok: false; reason: 'unknown-issuer' } {
    const path = this.buildPath(cert, intermediates);
    if (path.ok === false) return { ok: false, reason: 'unknown-issuer' };
    const issuer = path.intermediates[0] ?? path.anchor;
    return verifyOcspStaple(staple, cert, issuer, this.clock());
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
        const chainLength = anchorIsLeaf(cert, anchor) ? 1 : used.length + 2;
        if (this.maxDepth !== undefined && chainLength > this.maxDepth + 1) return { ok: false, reason: 'chain-too-long' };
        return { ok: true, anchor, intermediates: used };
      }
      const next = intermediates.find((candidate) => candidate.subject === current.issuer
        && !used.includes(candidate)
        && PkiKeyPair.verify(candidate.publicKey, tbsPayload(dropSignature(current)), current.signature));
      if (!next) {
        const forged = intermediates.some((candidate) => candidate.subject === current.issuer);
        return { ok: false, reason: forged ? 'bad-signature' : 'unknown' };
      }
      if (this.maxDepth !== undefined && used.length + 3 > this.maxDepth + 1) return { ok: false, reason: 'chain-too-long' };
      used.push(next);
      current = next;
    }
    return { ok: false, reason: 'path-length' };
  }

  private checkPath(
    leaf: X509Certificate, intermediates: readonly X509Certificate[], now: number, purpose: CertificatePurpose | undefined,
    level: number,
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
      if (!keyPermitted(level, ca.publicKey)) return { ok: false, reason: 'weak-ca-key' };
    }
    if (purpose) {
      const eku = leaf.extensions?.extKeyUsage;
      if (eku && eku.length > 0 && !eku.includes(purpose) && !eku.includes('anyExtendedKeyUsage')) {
        return { ok: false, reason: 'purpose' };
      }
    }
    if (!keyPermitted(level, leaf.publicKey)) return { ok: false, reason: 'weak-key' };
    return null;
  }
}

function anchorIsLeaf(cert: X509Certificate, anchor: X509Certificate): boolean {
  return cert.subject === anchor.subject && cert.publicKey.material === anchor.publicKey.material;
}

type PathResult =
  | { readonly ok: true; readonly anchor: X509Certificate; readonly intermediates: readonly X509Certificate[] }
  | VerificationFailure;

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
