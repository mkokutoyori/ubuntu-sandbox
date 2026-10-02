import { verifyOcspStaple } from '@/network/pki/OcspResponder';
import { ocspTimeIsValid } from '@/network/pki/OcspWire';
import type { SignedOcspResponse } from '@/network/pki/OcspResponder';
import type { X509Certificate } from '@/network/pki/X509Certificate';

export function judgeCertStatus(
  staple: SignedOcspResponse | null, peer: X509Certificate | null, chain: readonly X509Certificate[],
  anchors: readonly X509Certificate[], now: number,
): string | null {
  if (staple === null || peer === null) return 'No OCSP response received';
  const issuer = [...chain.slice(1), ...anchors].find((c) => c.subject === peer.issuer);
  if (!issuer) return 'Could not add issuer cert to OCSP response';
  if (staple.tbs.serialNumber !== peer.serialNumber || staple.tbs.issuer !== peer.issuer) {
    return 'Could not find certificate ID in OCSP response';
  }
  const verdict = verifyOcspStaple(staple, peer, issuer, staple.tbs.thisUpdate);
  if (verdict.ok === false) return 'OCSP response verification failed';
  if (!ocspTimeIsValid(staple, now, 300_000, null)) return 'OCSP response has expired';
  if (staple.tbs.status === 'revoked') return 'SSL certificate revocation reason: unspecified (0)';
  if (staple.tbs.status === 'unknown') return 'SSL server certificate status verification FAILED';
  return null;
}
