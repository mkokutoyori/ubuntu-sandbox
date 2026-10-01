import type { X509Certificate } from './X509Certificate';
import type { CertificateAuthority } from './CertificateAuthority';
import { PkiKeyPair } from './PkiKeyPair';

export type OcspStatus = 'good' | 'revoked' | 'unknown';

export interface OcspSingleResponse {
  readonly serialNumber: string;
  readonly status: OcspStatus;
  readonly revokedAt?: number;
  readonly producedAt: number;
  readonly issuer: string;
}

export interface IOcspResponder {
  check(cert: X509Certificate, now: number): OcspSingleResponse;
}

export class OcspResponder implements IOcspResponder {
  private queries = 0;

  constructor(private readonly ca: CertificateAuthority) {}

  getQueryCount(): number {
    return this.queries;
  }

  respond(cert: X509Certificate, now: number, validityMs: number = DEFAULT_OCSP_VALIDITY_MS): SignedOcspResponse {
    const single = this.check(cert, now);
    const tbs: OcspTbsResponse = {
      serialNumber: cert.serialNumber, issuer: cert.issuer, status: single.status,
      ...(single.revokedAt !== undefined ? { revokedAt: single.revokedAt } : {}),
      thisUpdate: now, nextUpdate: now + validityMs,
    };
    return { tbs, signature: PkiKeyPair.sign(this.ca.signingKey, ocspTbsPayload(tbs)) };
  }

  check(cert: X509Certificate, now: number): OcspSingleResponse {
    this.queries++;
    if (cert.issuer !== this.ca.rootCertificate.subject) {
      return { serialNumber: cert.serialNumber, status: 'unknown', producedAt: now, issuer: cert.issuer };
    }
    const crl = this.ca.publishCRL(now);
    const revokedEntry = crl.revoked.find((e) => e.serialNumber === cert.serialNumber);
    if (revokedEntry) {
      return {
        serialNumber: cert.serialNumber,
        status: 'revoked',
        revokedAt: revokedEntry.revocationDate,
        producedAt: now,
        issuer: cert.issuer,
      };
    }
    return { serialNumber: cert.serialNumber, status: 'good', producedAt: now, issuer: cert.issuer };
  }
}

export interface OcspTbsResponse {
  readonly serialNumber: string;
  readonly issuer: string;
  readonly status: OcspStatus;
  readonly revokedAt?: number;
  readonly thisUpdate: number;
  readonly nextUpdate: number;
}

export interface SignedOcspResponse {
  readonly tbs: OcspTbsResponse;
  readonly signature: string;
}

export const DEFAULT_OCSP_VALIDITY_MS = 4 * 24 * 3600 * 1000;

export function ocspTbsPayload(tbs: OcspTbsResponse): string {
  return JSON.stringify({
    sn: tbs.serialNumber, i: tbs.issuer, st: tbs.status, ra: tbs.revokedAt ?? null, tu: tbs.thisUpdate, nu: tbs.nextUpdate,
  });
}

export type OcspStapleVerdict =
  | { readonly ok: true; readonly status: OcspStatus }
  | { readonly ok: false; readonly reason: 'bad-signature' | 'wrong-certificate' | 'stale' | 'not-yet-valid' };

export function verifyOcspStaple(
  staple: SignedOcspResponse, cert: X509Certificate, issuer: X509Certificate, now: number,
): OcspStapleVerdict {
  if (!PkiKeyPair.verify(issuer.publicKey, ocspTbsPayload(staple.tbs), staple.signature)) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (staple.tbs.serialNumber !== cert.serialNumber || staple.tbs.issuer !== cert.issuer) {
    return { ok: false, reason: 'wrong-certificate' };
  }
  if (now < staple.tbs.thisUpdate) return { ok: false, reason: 'not-yet-valid' };
  if (now > staple.tbs.nextUpdate) return { ok: false, reason: 'stale' };
  return { ok: true, status: staple.tbs.status };
}
