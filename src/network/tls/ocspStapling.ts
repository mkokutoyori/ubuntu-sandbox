import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { OcspResponseMessage } from '@/network/pki/OcspWire';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { AlertDescription } from './alerts';

export type OcspStapleSource = OcspResponseMessage | ((cert: X509Certificate) => OcspResponseMessage | null);

export function resolveStaple(source: OcspStapleSource | undefined, cert: X509Certificate): OcspResponseMessage | undefined {
  if (source === undefined) return undefined;
  const staple = typeof source === 'function' ? source(cert) : source;
  return staple ?? undefined;
}

export function stapleAlert(
  verifier: CertificateVerifier, leaf: X509Certificate, chain: readonly X509Certificate[],
  staple: OcspResponseMessage | undefined, required: boolean,
): AlertDescription | null {
  if (staple === undefined) return required ? 'bad_certificate_status_response' : null;
  const verdict = verifier.checkOcspStaple(leaf, chain, staple);
  if (verdict.ok === false) return 'bad_certificate_status_response';
  if (verdict.status === 'revoked') return 'certificate_revoked';
  if (verdict.status === 'unknown') return 'bad_certificate_status_response';
  return null;
}
