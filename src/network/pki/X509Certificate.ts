import { PkiKeyPair, type PkiPrivateKey, type PkiPublicKey } from './PkiKeyPair';
import { IPAddress, IPv6Address } from '@/network/core/types';
import { canonicalSerial, tbsBytesOf } from './der/X509Der';
import { canonicalDistinguishedName } from './der/DistinguishedName';

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
    keyUsage?: readonly ('digitalSignature' | 'nonRepudiation' | 'keyEncipherment' | 'dataEncipherment' | 'keyAgreement' | 'keyCertSign' | 'cRLSign' | 'encipherOnly' | 'decipherOnly')[];
    /** RFC 5280 §4.2.1.12 Extended Key Usage (e.g. `serverAuth`, `clientAuth`) — stamped from the issuing AD CS certificate template, if any. */
    extKeyUsage?: readonly string[];
    subjectAltName?: readonly string[];
    crlDistributionPoints?: readonly string[];
    authorityInfoAccess?: readonly { readonly method: 'OCSP' | 'caIssuers'; readonly uri: string }[];
    subjectKeyIdentifier?: string;
    authorityKeyIdentifier?: { readonly keyid?: string; readonly issuer?: string; readonly serial?: string };
    criticalExtensions?: readonly string[];
  }>;
}

export interface X509Certificate extends X509CertificateFields {
  readonly signature: string;
}

export function tbsPayload(c: X509CertificateFields): Uint8Array {
  return tbsBytesOf(c);
}

function wholeSeconds(epochMs: number): number {
  return Math.floor(epochMs / 1000) * 1000;
}

export function canonicalGeneralName(entry: string): string {
  if (/^(DNS|IP|email|URI):/s.test(entry)) return entry;
  return IPAddress.tryParse(entry) || IPv6Address.tryParse(entry) ? `IP:${entry}` : `DNS:${entry}`;
}

export function normalizeCertificateFields(fields: X509CertificateFields): X509CertificateFields {
  const extensions = fields.extensions && fields.extensions.subjectAltName
    ? { ...fields.extensions, subjectAltName: Object.freeze(fields.extensions.subjectAltName.map(canonicalGeneralName)) }
    : fields.extensions;
  return {
    ...fields,
    serialNumber: canonicalSerial(fields.serialNumber),
    subject: canonicalDistinguishedName(fields.subject),
    issuer: canonicalDistinguishedName(fields.issuer),
    notBefore: wholeSeconds(fields.notBefore),
    notAfter: wholeSeconds(fields.notAfter),
    ...(extensions ? { extensions } : {}),
  };
}

export function signCertificate(fields: X509CertificateFields, privateKey: PkiPrivateKey): X509Certificate {
  const normalized = normalizeCertificateFields(fields);
  return { ...normalized, signature: PkiKeyPair.sign(privateKey, tbsBytesOf(normalized)) };
}

export function isSelfSigned(cert: X509Certificate): boolean {
  return cert.subject === cert.issuer;
}
