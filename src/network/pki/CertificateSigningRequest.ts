import { PkiKeyPair, type PkiPrivateKey, type PkiPublicKey } from './PkiKeyPair';
import type { CertificateRequest } from './pem';
import { canonicalDistinguishedName } from './der/DistinguishedName';
import { certificationRequestInfoOf, verifyCertificateRequestSignature } from './der/CsrDer';
import { canonicalGeneralName } from './X509Certificate';

export function buildCertificateRequest(
  subject: string,
  keys: { publicKey: PkiPublicKey; privateKey: PkiPrivateKey },
  subjectAltName?: readonly string[],
  extensions?: CertificateRequest['extensions'],
): CertificateRequest {
  const names = subjectAltName && subjectAltName.length > 0
    ? Object.freeze(subjectAltName.map(canonicalGeneralName)) : undefined;
  const merged = names || extensions ? { ...extensions, ...(names ? { subjectAltName: names } : {}) } : undefined;
  const body = { subject: canonicalDistinguishedName(subject), publicKey: keys.publicKey, extensions: merged };
  const signature = PkiKeyPair.sign(keys.privateKey, certificationRequestInfoOf(body));
  return {
    ...body,
    signatureAlgorithm: signature.startsWith('ecdsa:') ? 'ecdsa-with-SHA256' : 'sha256WithRSAEncryption',
    signature,
  };
}

export const verifyCertificateRequest = verifyCertificateRequestSignature;
