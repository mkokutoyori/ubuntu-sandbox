import type { X509Certificate } from './X509Certificate';
import type { CertificateAuthority } from './CertificateAuthority';

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
