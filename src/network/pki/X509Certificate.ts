import type { PkiPublicKey } from './PkiKeyPair';

export interface X509CertificateFields {
  readonly version: 3;
  readonly serialNumber: string;
  readonly subject: string;
  readonly issuer: string;
  readonly notBefore: number;
  readonly notAfter: number;
  readonly publicKey: PkiPublicKey;
  readonly signatureAlgorithm: 'sha256WithRSAEncryption' | 'ecdsa-with-SHA256';
  readonly extensions?: Readonly<{
    basicConstraints?: { readonly cA: boolean; readonly pathLenConstraint?: number };
    keyUsage?: readonly ('digitalSignature' | 'keyCertSign' | 'cRLSign' | 'keyEncipherment')[];
    subjectAltName?: readonly string[];
    crlDistributionPoints?: readonly string[];
  }>;
}

export interface X509Certificate extends X509CertificateFields {
  readonly signature: string;
}

export function tbsPayload(c: X509CertificateFields): string {
  return JSON.stringify({
    v: c.version,
    sn: c.serialNumber,
    s: c.subject,
    i: c.issuer,
    nb: c.notBefore,
    na: c.notAfter,
    pk: c.publicKey.material,
    alg: c.signatureAlgorithm,
    ext: c.extensions ?? {},
  });
}

export function isSelfSigned(cert: X509Certificate): boolean {
  return cert.subject === cert.issuer;
}
