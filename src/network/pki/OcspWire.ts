import { bytesToHex } from '@/crypto/encoding';
import { sha1, sha256 } from '@/crypto/hash';
import { PkiKeyPair, type PkiPrivateKey } from './PkiKeyPair';
import type { X509Certificate } from './X509Certificate';
import { tbsBytesOf, sameSerial, issuerNameDerOf, subjectNameDerOf, subjectPublicKeyBitsOf } from './der/X509Der';
import { encodeResponseData, responseDataOf } from './der/OcspDer';

export const OCSP_REQUEST_CONTENT_TYPE = 'application/ocsp-request';
export const OCSP_RESPONSE_CONTENT_TYPE = 'application/ocsp-response';
export const DEFAULT_OCSP_VALIDITY_MS = 4 * 24 * 3600 * 1000;

export type OcspStatus = 'good' | 'revoked' | 'unknown';
export type OcspHashAlgorithm = 'sha1' | 'sha256';

export interface OcspCertId {
  readonly hashAlgorithm: OcspHashAlgorithm;
  readonly issuerNameHash: string;
  readonly issuerKeyHash: string;
  readonly serialNumber: string;
}

export interface OcspRequestMessage {
  readonly ids: readonly OcspCertId[];
  readonly nonce?: string;
}

export type OcspResponseStatus =
  | 'successful' | 'malformedRequest' | 'internalError' | 'tryLater' | 'sigRequired' | 'unauthorized';

export const OCSP_RESPONSE_STATUS_CODE: Readonly<Record<OcspResponseStatus, number>> = {
  successful: 0, malformedRequest: 1, internalError: 2, tryLater: 3, sigRequired: 5, unauthorized: 6,
};

const OCSP_REASON_NAMES: Readonly<Record<number, string>> = {
  0: 'unspecified', 1: 'keyCompromise', 2: 'CACompromise', 3: 'affiliationChanged', 4: 'superseded',
  5: 'cessationOfOperation', 6: 'certificateHold', 8: 'removeFromCRL',
};

export function ocspReasonName(code: number): string {
  return OCSP_REASON_NAMES[code] ?? 'unknown';
}

export function ocspReasonCode(name: string): number | undefined {
  const entry = Object.entries(OCSP_REASON_NAMES).find(([, value]) => value.toLowerCase() === name.toLowerCase());
  return entry === undefined ? undefined : Number(entry[0]);
}

export interface OcspSingle {
  readonly certId: OcspCertId;
  readonly status: OcspStatus;
  readonly revokedAt?: number;
  readonly revocationReason?: number;
  readonly thisUpdate: number;
  readonly nextUpdate?: number;
}

export type OcspResponderId = { readonly name: string } | { readonly keyHash: string };

export interface OcspResponseMessage {
  readonly status: OcspResponseStatus;
  readonly responder?: OcspResponderId;
  readonly producedAt?: number;
  readonly nonce?: string;
  readonly singles: readonly OcspSingle[];
  readonly signatureAlgorithm?: 'sha256WithRSAEncryption' | 'ecdsa-with-SHA256';
  readonly signature?: string;
  readonly responderCertificates?: readonly X509Certificate[];
}

function digest(algorithm: OcspHashAlgorithm, bytes: Uint8Array): string {
  return bytesToHex(algorithm === 'sha256' ? sha256(bytes) : sha1(bytes));
}

export function ocspCertIdFor(
  cert: X509Certificate, issuer: X509Certificate, hashAlgorithm: OcspHashAlgorithm = 'sha1',
): OcspCertId {
  return {
    hashAlgorithm,
    issuerNameHash: digest(hashAlgorithm, issuerNameDerOf(cert)),
    issuerKeyHash: digest(hashAlgorithm, subjectPublicKeyBitsOf(issuer.publicKey)),
    serialNumber: cert.serialNumber,
  };
}

export function ocspCertIdForSerial(
  serialNumber: string, issuer: X509Certificate, hashAlgorithm: OcspHashAlgorithm = 'sha1',
): OcspCertId {
  return {
    hashAlgorithm,
    issuerNameHash: digest(hashAlgorithm, subjectNameDerOf(issuer)),
    issuerKeyHash: digest(hashAlgorithm, subjectPublicKeyBitsOf(issuer.publicKey)),
    serialNumber,
  };
}

export function sameCertId(a: OcspCertId, b: OcspCertId): boolean {
  return a.hashAlgorithm === b.hashAlgorithm && a.issuerNameHash === b.issuerNameHash
    && a.issuerKeyHash === b.issuerKeyHash && sameSerial(a.serialNumber, b.serialNumber);
}

export function certIdIsIssuedBy(id: OcspCertId, issuer: X509Certificate): boolean {
  return id.issuerNameHash === digest(id.hashAlgorithm, subjectNameDerOf(issuer))
    && id.issuerKeyHash === digest(id.hashAlgorithm, subjectPublicKeyBitsOf(issuer.publicKey));
}

export function certIdMatches(id: OcspCertId, cert: X509Certificate, issuer: X509Certificate): boolean {
  return sameSerial(id.serialNumber, cert.serialNumber)
    && id.issuerNameHash === digest(id.hashAlgorithm, issuerNameDerOf(cert))
    && id.issuerKeyHash === digest(id.hashAlgorithm, subjectPublicKeyBitsOf(issuer.publicKey));
}

export function findSingle(
  response: OcspResponseMessage, cert: X509Certificate, issuer: X509Certificate,
): OcspSingle | undefined {
  return response.singles.find((single) => certIdMatches(single.certId, cert, issuer));
}

export interface IndexedStatus {
  readonly status: OcspStatus;
  readonly revokedAt?: number;
  readonly revocationReason?: number;
}

export interface OcspStatusSource {
  lookup(id: OcspCertId): IndexedStatus;
}

export interface OcspSigner {
  readonly key: PkiPrivateKey;
  readonly certificate: X509Certificate;
  readonly identifyByKey?: boolean;
}

export interface OcspResponderOptions {
  readonly now: number;
  readonly validityMs?: number | null;
  readonly issuer: X509Certificate;
  readonly includeCertificates?: boolean;
}

export function responderIdOf(signer: X509Certificate, byKey: boolean): OcspResponderId {
  return byKey
    ? { keyHash: digest('sha1', subjectPublicKeyBitsOf(signer.publicKey)) }
    : { name: signer.subject };
}

function responderIdMatches(id: OcspResponderId | undefined, cert: X509Certificate): boolean {
  if (id === undefined) return true;
  if ('name' in id) return id.name === cert.subject;
  return id.keyHash === digest('sha1', subjectPublicKeyBitsOf(cert.publicKey));
}

export function signOcspResponse(
  unsigned: Omit<OcspResponseMessage, 'signature' | 'signatureAlgorithm'>, key: PkiPrivateKey,
): OcspResponseMessage {
  const signature = PkiKeyPair.sign(key, encodeResponseData(unsigned));
  return {
    ...unsigned,
    signatureAlgorithm: signature.startsWith('ecdsa:') ? 'ecdsa-with-SHA256' : 'sha256WithRSAEncryption',
    signature,
  };
}

export function buildOcspResponse(
  request: OcspRequestMessage, source: OcspStatusSource, signer: OcspSigner, options: OcspResponderOptions,
): OcspResponseMessage {
  if (request.ids.length === 0) return { status: 'malformedRequest', singles: [] };
  const validity = options.validityMs === undefined ? DEFAULT_OCSP_VALIDITY_MS : options.validityMs;
  const singles = request.ids.map((certId): OcspSingle => {
    const known = certIdIsIssuedBy(certId, options.issuer) ? source.lookup(certId) : { status: 'unknown' as const };
    return {
      certId, status: known.status,
      ...(known.revokedAt !== undefined ? { revokedAt: known.revokedAt } : {}),
      ...(known.revocationReason !== undefined ? { revocationReason: known.revocationReason } : {}),
      thisUpdate: options.now,
      ...(validity !== null ? { nextUpdate: options.now + validity } : {}),
    };
  });
  return signOcspResponse({
    status: 'successful', responder: responderIdOf(signer.certificate, signer.identifyByKey === true),
    producedAt: options.now,
    ...(request.nonce !== undefined ? { nonce: request.nonce } : {}),
    singles, responderCertificates: options.includeCertificates === false ? [] : [signer.certificate],
  }, signer.key);
}

export type OcspVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'bad-signature' | 'wrong-certificate' | 'stale' | 'not-yet-valid' | 'nonce-mismatch' | 'no-responder' };

function ocspSigningDelegation(candidate: X509Certificate, trusted: readonly X509Certificate[]): boolean {
  if (trusted.some((c) => sameSerial(c.serialNumber, candidate.serialNumber) && c.subject === candidate.subject)) return true;
  const usages = candidate.extensions?.extKeyUsage ?? [];
  if (!usages.includes('OCSPSigning')) return false;
  return trusted.some((c) => c.subject === candidate.issuer
    && PkiKeyPair.verify(c.publicKey, tbsBytesOf(candidate), candidate.signature));
}

export function ocspSignerFor(
  response: OcspResponseMessage, trusted: readonly X509Certificate[],
): X509Certificate | null {
  for (const candidate of response.responderCertificates ?? []) {
    if (responderIdMatches(response.responder, candidate) && ocspSigningDelegation(candidate, trusted)) return candidate;
  }
  return trusted.find((c) => response.responder !== undefined && responderIdMatches(response.responder, c)) ?? null;
}

export function verifyOcspResponse(
  response: OcspResponseMessage, request: OcspRequestMessage | null, trusted: readonly X509Certificate[],
  now: number, checkNonce: boolean,
): OcspVerification {
  void now;
  if (checkNonce && request?.nonce !== undefined && response.nonce !== undefined && response.nonce !== request.nonce) {
    return { ok: false, reason: 'nonce-mismatch' };
  }
  if (trusted.length === 0) return { ok: false, reason: 'no-responder' };
  const signer = ocspSignerFor(response, trusted);
  if (!signer) return { ok: false, reason: 'no-responder' };
  if (response.signature === undefined
    || !PkiKeyPair.verify(signer.publicKey, responseDataOf(response), response.signature)) {
    return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true };
}

export function ocspTimeIsValid(single: OcspSingle, now: number, skewMs: number, maxAgeMs: number | null): boolean {
  if (now + skewMs < single.thisUpdate) return false;
  if (maxAgeMs !== null && single.thisUpdate + maxAgeMs < now - skewMs) return false;
  return single.nextUpdate === undefined || now - skewMs <= single.nextUpdate;
}

export type OcspStapleVerdict =
  | { readonly ok: true; readonly status: OcspStatus }
  | { readonly ok: false; readonly reason: 'bad-signature' | 'wrong-certificate' | 'stale' | 'not-yet-valid' | 'no-responder' };

export function verifyOcspStaple(
  staple: OcspResponseMessage, cert: X509Certificate, issuer: X509Certificate, now: number,
): OcspStapleVerdict {
  if (staple.status !== 'successful') return { ok: false, reason: 'bad-signature' };
  const verdict = verifyOcspResponse(staple, null, [issuer], now, false);
  if (verdict.ok === false) return { ok: false, reason: verdict.reason === 'no-responder' ? 'no-responder' : 'bad-signature' };
  const single = findSingle(staple, cert, issuer);
  if (!single) return { ok: false, reason: 'wrong-certificate' };
  if (now < single.thisUpdate) return { ok: false, reason: 'not-yet-valid' };
  if (single.nextUpdate !== undefined && now > single.nextUpdate) return { ok: false, reason: 'stale' };
  return { ok: true, status: single.status };
}
