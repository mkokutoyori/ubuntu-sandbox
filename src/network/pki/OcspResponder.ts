import type { X509Certificate } from './X509Certificate';
import type { CertificateAuthority } from './CertificateAuthority';
import { sameSerial } from './der/X509Der';
import {
  DEFAULT_OCSP_VALIDITY_MS, ocspCertIdFor, signOcspResponse, responderIdOf,
  type OcspResponseMessage, type OcspStatus,
} from './OcspWire';

export interface OcspSingleResponse {
  readonly serialNumber: string;
  readonly status: OcspStatus;
  readonly revokedAt?: number;
  readonly producedAt: number;
  readonly issuer: string;
}

export interface IOcspResponder {
  check(cert: X509Certificate, now: number, issuer?: X509Certificate): OcspSingleResponse;
}

export class OcspResponder implements IOcspResponder {
  private queries = 0;

  constructor(private readonly ca: CertificateAuthority) {}

  getQueryCount(): number {
    return this.queries;
  }

  respond(cert: X509Certificate, now: number, validityMs: number = DEFAULT_OCSP_VALIDITY_MS): OcspResponseMessage {
    const single = this.check(cert, now);
    return signOcspResponse({
      status: 'successful',
      responder: responderIdOf(this.ca.rootCertificate, false),
      producedAt: now,
      singles: [{
        certId: ocspCertIdFor(cert, this.ca.rootCertificate),
        status: single.status,
        ...(single.revokedAt !== undefined ? { revokedAt: single.revokedAt } : {}),
        thisUpdate: now,
        nextUpdate: now + validityMs,
      }],
    }, this.ca.signingKey);
  }

  check(cert: X509Certificate, now: number): OcspSingleResponse {
    this.queries++;
    if (cert.issuer !== this.ca.rootCertificate.subject) {
      return { serialNumber: cert.serialNumber, status: 'unknown', producedAt: now, issuer: cert.issuer };
    }
    const crl = this.ca.publishCRL(now);
    const revokedEntry = crl.revoked.find((e) => sameSerial(e.serialNumber, cert.serialNumber));
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
