import type { X509Certificate } from '@/network/pki/X509Certificate';
import { pemToCert } from '@/network/pki/pem';
import type { PkiTrustpool } from '../security/CiscoSecurityConfig';

const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

export type BundleParse = { readonly certificates: X509Certificate[] } | { readonly error: string };

export function parseBundle(text: string): BundleParse {
  const blocks = text.match(CERTIFICATE_BLOCK) ?? [];
  if (blocks.length === 0) return { error: '% The CA bundle holds no PEM certificate' };
  const certificates: X509Certificate[] = [];
  for (const block of blocks) {
    const certificate = pemToCert(block);
    if (!certificate) return { error: '% A certificate of the CA bundle could not be read' };
    certificates.push(certificate);
  }
  return { certificates };
}

const sameCertificate = (a: X509Certificate, b: X509Certificate): boolean =>
  a.serialNumber === b.serialNumber && a.issuer === b.issuer;

export function mergeIntoTrustpool(pool: PkiTrustpool, incoming: readonly X509Certificate[], clean: boolean): number {
  if (clean) pool.certificates = [];
  let added = 0;
  for (const certificate of incoming) {
    if (pool.certificates.some((held) => sameCertificate(held, certificate))) continue;
    pool.certificates.push(certificate);
    added++;
  }
  return added;
}
