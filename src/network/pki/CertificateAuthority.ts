import { PkiKeyPair, type PkiPrivateKey } from './PkiKeyPair';
import { type X509Certificate, type X509CertificateFields, tbsPayload } from './X509Certificate';
import { CertificateRevocationList, type RevokedEntry } from './CertificateRevocationList';

export interface IssueOptions {
  readonly subject: string;
  readonly notBefore: number;
  readonly notAfter: number;
  readonly subjectAltNames?: readonly string[];
  readonly signatureAlgorithm?: 'sha256WithRSAEncryption' | 'ecdsa-with-SHA256';
  readonly crlDistributionPoints?: readonly string[];
  readonly serialNumber?: string;
}

export interface IssuedCertificate {
  readonly cert: X509Certificate;
  readonly privateKey: PkiPrivateKey;
}

export interface CertificateAuthorityOptions {
  readonly now: number;
  readonly validityMs?: number;
  readonly algorithm?: 'rsa' | 'ecdsa';
}

let serialCounter = 0x1000;
function nextSerial(): string {
  serialCounter += 1;
  const hex = serialCounter.toString(16);
  return hex.padStart(16, '0');
}

export class CertificateAuthority {
  readonly rootCertificate: X509Certificate;
  private readonly rootKey: PkiPrivateKey;
  private readonly revoked = new Map<string, RevokedEntry>();
  private crlNumber = 0;

  private constructor(root: X509Certificate, rootKey: PkiPrivateKey) {
    this.rootCertificate = root;
    this.rootKey = rootKey;
  }

  static generate(subject: string, opts: CertificateAuthorityOptions): CertificateAuthority {
    const keys = PkiKeyPair.generate(opts.algorithm ?? 'rsa');
    const fields: X509CertificateFields = {
      version: 3,
      serialNumber: nextSerial(),
      subject,
      issuer: subject,
      notBefore: opts.now,
      notAfter: opts.now + (opts.validityMs ?? 10 * 365 * 24 * 3600 * 1000),
      publicKey: keys.publicKey,
      signatureAlgorithm: opts.algorithm === 'ecdsa' ? 'ecdsa-with-SHA256' : 'sha256WithRSAEncryption',
      extensions: Object.freeze({
        basicConstraints: Object.freeze({ cA: true, pathLenConstraint: 0 }),
        keyUsage: Object.freeze(['keyCertSign', 'cRLSign'] as const),
      }),
    };
    const signature = PkiKeyPair.sign(keys.privateKey, tbsPayload(fields));
    const root: X509Certificate = { ...fields, signature };
    return new CertificateAuthority(root, keys.privateKey);
  }

  issueCertificate(opts: IssueOptions): IssuedCertificate {
    if (opts.notAfter <= opts.notBefore) {
      throw new Error(`notAfter (${opts.notAfter}) must be > notBefore (${opts.notBefore})`);
    }
    const keys = PkiKeyPair.generate(this.rootCertificate.publicKey.algorithm);
    const fields: X509CertificateFields = {
      version: 3,
      serialNumber: opts.serialNumber ?? nextSerial(),
      subject: opts.subject,
      issuer: this.rootCertificate.subject,
      notBefore: opts.notBefore,
      notAfter: opts.notAfter,
      publicKey: keys.publicKey,
      signatureAlgorithm: this.rootCertificate.signatureAlgorithm,
      extensions: Object.freeze({
        basicConstraints: Object.freeze({ cA: false }),
        keyUsage: Object.freeze(['digitalSignature', 'keyEncipherment'] as const),
        subjectAltName: opts.subjectAltNames ? Object.freeze([...opts.subjectAltNames]) : undefined,
        crlDistributionPoints: opts.crlDistributionPoints ? Object.freeze([...opts.crlDistributionPoints]) : undefined,
      }),
    };
    const signature = PkiKeyPair.sign(this.rootKey, tbsPayload(fields));
    return { cert: { ...fields, signature }, privateKey: keys.privateKey };
  }

  revoke(serialNumber: string, revocationDate: number, reasonCode?: RevokedEntry['reasonCode']): void {
    this.revoked.set(serialNumber, { serialNumber, revocationDate, reasonCode });
  }

  publishCRL(now: number, validityMs: number = 24 * 3600 * 1000): CertificateRevocationList {
    this.crlNumber += 1;
    return CertificateRevocationList.sign({
      version: 2,
      issuer: this.rootCertificate.subject,
      thisUpdate: now,
      nextUpdate: now + validityMs,
      signatureAlgorithm: this.rootCertificate.signatureAlgorithm,
      revoked: Object.freeze([...this.revoked.values()]),
    }, this.rootKey);
  }
}
