import { verifyOcspStaple, findSingle, ocspTimeIsValid, ocspReasonName, type OcspResponseMessage } from '@/network/pki/OcspWire';
import type { X509Certificate } from '@/network/pki/X509Certificate';

export function judgeCertStatus(
  staple: OcspResponseMessage | null, peer: X509Certificate | null, chain: readonly X509Certificate[],
  anchors: readonly X509Certificate[], now: number,
): string | null {
  if (staple === null || peer === null) return 'No OCSP response received';
  const issuer = [...chain.slice(1), ...anchors].find((c) => c.subject === peer.issuer);
  if (!issuer) return 'Could not add issuer cert to OCSP response';
  const single = findSingle(staple, peer, issuer);
  if (!single) return 'Could not find certificate ID in OCSP response';
  const verdict = verifyOcspStaple(staple, peer, issuer, single.thisUpdate);
  if (verdict.ok === false) return 'OCSP response verification failed';
  if (!ocspTimeIsValid(single, now, 300_000, null)) return 'OCSP response has expired';
  if (single.status === 'revoked') {
    const reason = single.revocationReason ?? 0;
    return `SSL certificate revocation reason: ${ocspReasonName(reason)} (${reason})`;
  }
  if (single.status === 'unknown') return 'SSL server certificate status verification FAILED';
  return null;
}
