import { PkiKeyPair, type PkiPrivateKey } from './PkiKeyPair';
import { tbsPayload, type X509Certificate } from './X509Certificate';

function withoutSignature(cert: X509Certificate): X509Certificate {
  return { ...cert, signature: '' };
}
import {
  DEFAULT_OCSP_VALIDITY_MS, ocspTbsPayload, verifyOcspStaple,
  type OcspStatus, type OcspTbsResponse, type SignedOcspResponse,
} from './OcspResponder';

export const OCSP_REQUEST_CONTENT_TYPE = 'application/ocsp-request';
export const OCSP_RESPONSE_CONTENT_TYPE = 'application/ocsp-response';

export interface OcspCertId {
  readonly issuer: string;
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

export interface OcspResponseMessage {
  readonly status: OcspResponseStatus;
  readonly responder?: string;
  readonly producedAt?: number;
  readonly nonce?: string;
  readonly singles: readonly SignedOcspResponse[];
  readonly responderCertificate?: X509Certificate;
}

export function certIdOf(cert: X509Certificate): OcspCertId {
  return { issuer: cert.issuer, serialNumber: cert.serialNumber };
}

export interface IndexedStatus {
  readonly status: OcspStatus;
  readonly revokedAt?: number;
}

export interface OcspStatusSource {
  lookup(id: OcspCertId): IndexedStatus;
}

export interface OcspSigner {
  readonly name: string;
  readonly key: PkiPrivateKey;
  readonly certificate?: X509Certificate;
}

export interface OcspResponderOptions {
  readonly now: number;
  readonly validityMs?: number;
  readonly caSubject: string;
}

export function buildOcspResponse(
  request: OcspRequestMessage, source: OcspStatusSource, signer: OcspSigner, options: OcspResponderOptions,
): OcspResponseMessage {
  if (request.ids.length === 0) return { status: 'malformedRequest', singles: [] };
  const validity = options.validityMs ?? DEFAULT_OCSP_VALIDITY_MS;
  const singles = request.ids.map((id): SignedOcspResponse => {
    const known = id.issuer === options.caSubject ? source.lookup(id) : { status: 'unknown' as const };
    const tbs: OcspTbsResponse = {
      serialNumber: id.serialNumber, issuer: id.issuer, status: known.status,
      ...(known.revokedAt !== undefined ? { revokedAt: known.revokedAt } : {}),
      thisUpdate: options.now, nextUpdate: options.now + validity,
    };
    return { tbs, signature: PkiKeyPair.sign(signer.key, ocspTbsPayload(tbs)) };
  });
  return {
    status: 'successful', responder: signer.name, producedAt: options.now,
    ...(request.nonce !== undefined ? { nonce: request.nonce } : {}),
    singles, ...(signer.certificate ? { responderCertificate: signer.certificate } : {}),
  };
}

export type OcspVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'bad-signature' | 'wrong-certificate' | 'stale' | 'not-yet-valid' | 'nonce-mismatch' | 'no-responder' };

export function verifyOcspResponse(
  response: OcspResponseMessage, request: OcspRequestMessage | null, trusted: readonly X509Certificate[],
  now: number, checkNonce: boolean,
): OcspVerification {
  if (checkNonce && request?.nonce !== undefined && response.nonce !== undefined && response.nonce !== request.nonce) {
    return { ok: false, reason: 'nonce-mismatch' };
  }
  if (trusted.length === 0) return { ok: false, reason: 'no-responder' };
  const delegated = response.responderCertificate;
  let signer: X509Certificate | null = null;
  if (delegated) {
    const trustedItself = trusted.some((c) => c.serialNumber === delegated.serialNumber && c.subject === delegated.subject);
    const issuedByTrusted = trusted.some((c) => c.subject === delegated.issuer
      && PkiKeyPair.verify(c.publicKey, tbsPayload(withoutSignature(delegated)), delegated.signature));
    if (trustedItself || issuedByTrusted) signer = delegated;
  }
  for (const single of response.singles) {
    const authority = signer ?? trusted.find((c) => c.subject === single.tbs.issuer) ?? trusted[0];
    const placeholder = { serialNumber: single.tbs.serialNumber, issuer: single.tbs.issuer } as X509Certificate;
    const verdict = verifyOcspStaple(single, placeholder, authority, now);
    if (verdict.ok === false && verdict.reason !== 'stale' && verdict.reason !== 'not-yet-valid') return verdict;
  }
  return { ok: true };
}

export function ocspTimeIsValid(single: SignedOcspResponse, now: number, skewMs: number, maxAgeMs: number | null): boolean {
  if (now + skewMs < single.tbs.thisUpdate) return false;
  if (maxAgeMs !== null && single.tbs.thisUpdate + maxAgeMs < now - skewMs) return false;
  return now - skewMs <= single.tbs.nextUpdate;
}
