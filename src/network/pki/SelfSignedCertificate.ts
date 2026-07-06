/**
 * generateSelfSignedCertificate — a minimal self-signed leaf certificate
 * (subject === issuer), for callers that need a working private key
 * alongside the cert (`CertificateAuthority` deliberately keeps its own
 * root key private). Same "simulated crypto, real protocol shape"
 * convention as the rest of `src/network/pki/`.
 */
import { PkiKeyPair, type PkiPrivateKey } from './PkiKeyPair';
import { type X509Certificate, type X509CertificateFields, tbsPayload } from './X509Certificate';

export interface SelfSignedCertificateOptions {
  readonly now: number;
  readonly validityMs?: number;
  readonly extKeyUsage?: readonly string[];
}

let serialCounter = 0x5000;
function nextSerial(): string {
  serialCounter += 1;
  return serialCounter.toString(16).padStart(16, '0');
}

export function generateSelfSignedCertificate(
  subject: string, opts: SelfSignedCertificateOptions,
): { cert: X509Certificate; privateKey: PkiPrivateKey } {
  const keys = PkiKeyPair.generate('rsa');
  const fields: X509CertificateFields = {
    version: 3,
    serialNumber: nextSerial(),
    subject, issuer: subject,
    notBefore: opts.now,
    notAfter: opts.now + (opts.validityMs ?? 365 * 24 * 3600 * 1000),
    publicKey: keys.publicKey,
    signatureAlgorithm: 'sha256WithRSAEncryption',
    extensions: Object.freeze({
      basicConstraints: Object.freeze({ cA: false }),
      keyUsage: Object.freeze(['digitalSignature', 'keyEncipherment'] as const),
      extKeyUsage: opts.extKeyUsage ? Object.freeze([...opts.extKeyUsage]) : undefined,
    }),
  };
  const signature = PkiKeyPair.sign(keys.privateKey, tbsPayload(fields));
  return { cert: { ...fields, signature }, privateKey: keys.privateKey };
}
