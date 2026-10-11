import { sha256 } from '@/crypto/hash';
import { encodeCertificate } from '@/network/pki/der/X509Der';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { legacyKeyBits } from './legacy/legacyCipherSuites';
import { suiteInfo } from './suite13';

const encoder = new TextEncoder();

export const TLS_SERVER_END_POINT_PREFIX = 'tls-server-end-point:';
export const TLS_UNIQUE_PREFIX = 'tls-unique:';
const BITS_PER_BYTE = 8;

function concatenated(prefix: string, value: Uint8Array): Uint8Array {
  const head = encoder.encode(prefix);
  const out = new Uint8Array(head.length + value.length);
  out.set(head, 0);
  out.set(value, head.length);
  return out;
}

type Digest = (data: Uint8Array) => Uint8Array;

const END_POINT_DIGEST: Readonly<Record<X509Certificate['signatureAlgorithm'], Digest>> = {
  sha256WithRSAEncryption: sha256,
  'ecdsa-with-SHA256': sha256,
};

export function tlsServerEndPointOfDer(certificateDer: Uint8Array, digest: Digest): Uint8Array {
  return concatenated(TLS_SERVER_END_POINT_PREFIX, digest(certificateDer));
}

export function tlsServerEndPoint(certificate: X509Certificate): Uint8Array {
  return tlsServerEndPointOfDer(encodeCertificate(certificate), END_POINT_DIGEST[certificate.signatureAlgorithm]);
}

export function tlsUnique(firstFinishedVerifyData: Uint8Array): Uint8Array {
  return concatenated(TLS_UNIQUE_PREFIX, firstFinishedVerifyData);
}

export interface NegotiatedCipher {
  readonly version: string | null;
  readonly suite: string | null;
}

export function cipherKeyBits(negotiated: NegotiatedCipher): number | null {
  if (negotiated.suite === null) return null;
  if (negotiated.version === '1.3') return suiteInfo(negotiated.suite).keyLength * BITS_PER_BYTE;
  return legacyKeyBits(negotiated.suite);
}
