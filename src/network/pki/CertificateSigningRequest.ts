import { PkiKeyPair, type PkiPrivateKey, type PkiPublicKey } from './PkiKeyPair';
import type { CertificateRequest } from './pem';

export function buildCertificateRequest(
  subject: string,
  keys: { publicKey: PkiPublicKey; privateKey: PkiPrivateKey },
  subjectAltName?: readonly string[],
): CertificateRequest {
  return {
    subject,
    publicKey: keys.publicKey,
    signatureAlgorithm: 'sha256WithRSAEncryption',
    signature: PkiKeyPair.sign(keys.privateKey, subject),
    extensions: subjectAltName && subjectAltName.length > 0
      ? { subjectAltName } : undefined,
  };
}
