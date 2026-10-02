/**
 * generateSelfSignedCertificate — a minimal self-signed leaf certificate
 * (subject === issuer), for callers that need a working private key
 * alongside the cert (`CertificateAuthority` deliberately keeps its own
 * root key private). Same "simulated crypto, real protocol shape"
 * convention as the rest of `src/network/pki/`.
 */
import { PkiKeyPair, type PkiPrivateKey, type PkiPublicKey } from './PkiKeyPair';
import { type X509Certificate, type X509CertificateFields, signCertificate } from './X509Certificate';

export interface SelfSignedCertificateOptions {
  readonly now: number;
  readonly validityMs?: number;
  readonly extKeyUsage?: readonly string[];
  /**
   * Certify THIS key instead of generating a fresh one.
   *
   * Without it, a caller that already holds a key — `openssl req -x509
   * -keyout k.pem`, which has just written one to disk — got back a
   * certificate bound to a DIFFERENT key generated in here. Nothing
   * noticed as long as the two files were only ever read separately;
   * the pair failed the moment a TLS server tried to use them together.
   */
  readonly keyPair?: { readonly publicKey: PkiPublicKey; readonly privateKey: PkiPrivateKey };
  /**
   * Names for the subjectAltName extension.
   *
   * They belong HERE rather than being added to the returned certificate,
   * because `tbsPayload` covers the extensions: a caller that grafted a SAN
   * on afterwards produced a certificate whose signature no longer matched
   * its own content. `openssl req -x509 -addext subjectAltName=...` did
   * exactly that, and nothing noticed for as long as no anchor was ever
   * checked — the same blind spot that hid the mismatched key pair above.
   */
  readonly subjectAltName?: readonly string[];
  readonly extensions?: NonNullable<X509CertificateFields['extensions']>;
}

let serialCounter = 0x5000;
function nextSerial(): string {
  serialCounter += 1;
  return serialCounter.toString(16).padStart(16, '0');
}

export function generateSelfSignedCertificate(
  subject: string, opts: SelfSignedCertificateOptions,
): { cert: X509Certificate; privateKey: PkiPrivateKey } {
  const keys = opts.keyPair ?? PkiKeyPair.generate('rsa');
  const fields: X509CertificateFields = {
    version: 3,
    serialNumber: nextSerial(),
    subject, issuer: subject,
    notBefore: opts.now,
    notAfter: opts.now + (opts.validityMs ?? 365 * 24 * 3600 * 1000),
    publicKey: keys.publicKey,
    signatureAlgorithm: 'sha256WithRSAEncryption',
    extensions: opts.extensions ?? Object.freeze({
      basicConstraints: Object.freeze({ cA: false }),
      keyUsage: Object.freeze(['digitalSignature', 'keyEncipherment'] as const),
      extKeyUsage: opts.extKeyUsage ? Object.freeze([...opts.extKeyUsage]) : undefined,
      subjectAltName: opts.subjectAltName ? Object.freeze([...opts.subjectAltName]) : undefined,
    }),
  };
  return { cert: signCertificate(fields, keys.privateKey), privateKey: keys.privateKey };
}

export function selfSignedServiceCertificate(subject: string): { cert: X509Certificate; keyPair: PkiKeyPair } {
  const keyPair = PkiKeyPair.generate('rsa');
  const name = subject.includes('=') ? subject : `CN=${subject}`;
  const now = Date.now();
  const fields: X509CertificateFields = {
    version: 3, serialNumber: '1', subject: name, issuer: name,
    notBefore: now - 1000, notAfter: now + 365 * 24 * 3600 * 1000,
    publicKey: keyPair.publicKey, signatureAlgorithm: 'sha256WithRSAEncryption',
  };
  return { cert: signCertificate(fields, keyPair.privateKey), keyPair };
}
