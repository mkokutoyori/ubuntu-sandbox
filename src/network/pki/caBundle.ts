import { certToPem } from './pem';
import type { X509Certificate } from './X509Certificate';

export const CA_BUNDLE_PATH = '/etc/ssl/certs/ca-certificates.crt';

export function caBundlePem(anchors: readonly X509Certificate[]): string {
  return anchors.map((anchor) => certToPem(anchor)).join('');
}
