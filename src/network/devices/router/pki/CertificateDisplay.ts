import type { X509Certificate } from '@/network/pki/X509Certificate';
import { encodeCertificate } from '@/network/pki/der/X509Der';
import { certToPem } from '@/network/pki/pem';
import { bytesToHex } from '@/crypto/encoding';
import { md5, sha1 } from '@/crypto/hash';
import type { PkiTrustpoint, PkiTrustpool } from '../security/CiscoSecurityConfig';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function colonHex(bytes: Uint8Array): string {
  return (bytesToHex(bytes).toUpperCase().match(/.{8}/g) ?? []).join(' ');
}

export function iosDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

export function certificateFingerprints(certificate: X509Certificate): { md5: string; sha1: string } {
  const der = encodeCertificate(certificate);
  return { md5: colonHex(md5(der)), sha1: colonHex(sha1(der)) };
}

const nameLines = (distinguishedName: string): string[] =>
  distinguishedName.split(',').map((part) => `  ${part.trim().toLowerCase()}`);

export function describeCertificate(certificate: X509Certificate, title: string, associated: string, usage: string, verbose: boolean): string[] {
  if (!verbose) {
    return [title, '  Status: Available', `  Certificate Serial Number: ${certificate.serialNumber}`, `  Key Usage: ${usage}`];
  }
  const fingerprints = certificateFingerprints(certificate);
  const usages = certificate.extensions?.keyUsage ?? [];
  return [
    title, '  Status: Available', '  Version: 3', `  Certificate Serial Number: ${certificate.serialNumber}`,
    `  Certificate Usage: ${usage}`,
    '  Issuer:', ...nameLines(certificate.issuer).map((line) => `  ${line}`),
    '  Subject:', ...nameLines(certificate.subject).map((line) => `  ${line}`),
    ...(certificate.extensions?.crlDistributionPoints?.length
      ? ['  CRL Distribution Points:', ...certificate.extensions.crlDistributionPoints.map((point) => `    ${point}`)] : []),
    '  Validity Date:', `    start date: ${iosDate(certificate.notBefore)}`, `    end date: ${iosDate(certificate.notAfter)}`,
    '  Subject Key Info:',
    `    Public Key Algorithm: ${certificate.publicKey.algorithm === 'rsa' ? 'rsaEncryption' : 'id-ecPublicKey'}`,
    `  Signature Algorithm: ${certificate.signatureAlgorithm === 'sha256WithRSAEncryption' ? 'SHA256 with RSA Encryption' : 'ecdsa-with-SHA256'}`,
    `  Fingerprint MD5: ${fingerprints.md5}`, `  Fingerprint SHA1: ${fingerprints.sha1}`,
    '  X509v3 extensions:',
    ...(usages.length ? ['    X509v3 Key Usage:', ...usages.map((entry) => `      ${entry}`)] : []),
    ...(certificate.extensions?.subjectKeyIdentifier ? [`    X509v3 Subject Key ID: ${certificate.extensions.subjectKeyIdentifier}`] : []),
    `  Associated Trustpoints: ${associated}`,
  ];
}

export function renderCertificates(trustpoints: readonly PkiTrustpoint[], verbose: boolean): string {
  const blocks: string[] = [];
  for (const trustpoint of trustpoints) {
    if (trustpoint.localCert) blocks.push(describeCertificate(trustpoint.localCert, 'Certificate', trustpoint.name, 'General Purpose', verbose).join('\n'));
    else if (trustpoint.localKey || trustpoint.caCert) {
      if (trustpoint.localKey) blocks.push(['Certificate', '  Subject:', `    Name: ${trustpoint.subjectName ?? trustpoint.name}`, '  Status: Pending', '  Key Usage: General Purpose', `  Associated Trustpoint: ${trustpoint.name}`].join('\n'));
    }
    if (trustpoint.caCert) blocks.push(describeCertificate(trustpoint.caCert, 'CA Certificate', trustpoint.name, 'Not Set', verbose).join('\n'));
  }
  return blocks.join('\n');
}

export function renderCertificatesPem(trustpoints: readonly PkiTrustpoint[]): string {
  const out: string[] = [];
  for (const trustpoint of trustpoints) {
    out.push(`------Trustpoint: ${trustpoint.name}------`);
    if (!trustpoint.localCert) {
      out.push(`% The specified trustpoint is not enrolled (${trustpoint.name}).`, '% Only export the CA certificate in PEM format.');
    }
    if (trustpoint.caCert) out.push('% CA certificate:', certToPem(trustpoint.caCert).trimEnd());
    else out.push('% Error: failed to get CA cert.');
    if (trustpoint.localCert) out.push('% General Purpose Certificate:', certToPem(trustpoint.localCert).trimEnd());
  }
  return out.join('\n');
}

export function renderTrustpool(pool: PkiTrustpool, policy: boolean): string {
  const lines = pool.certificates.length === 0 ? ['The PKI trustpool holds no certificate'] : pool.certificates.flatMap(
    (certificate) => describeCertificate(certificate, 'CA Certificate', 'Trustpool', 'Signature', true),
  );
  if (!policy) return lines.join('\n');
  return [
    ...lines, '', 'PKI Trustpool Policy',
    `  CA bundle URL: ${pool.cabundleUrl ?? 'not configured'}`,
    `  Chain validation: ${pool.chainValidation ? 'up to a root certificate of the trustpool' : 'stops at the issuer of the peer certificate'}`,
  ].join('\n');
}
