import type { PkiPublicKey } from './PkiKeyPair';
import { PkiKeyPair } from './PkiKeyPair';

export interface RevokedEntry {
  readonly serialNumber: string;
  readonly revocationDate: number;
  readonly reasonCode?: 'unspecified' | 'keyCompromise' | 'cACompromise' | 'affiliationChanged' | 'superseded' | 'cessationOfOperation';
}

export interface CrlFields {
  readonly version: 2;
  readonly issuer: string;
  readonly thisUpdate: number;
  readonly nextUpdate: number;
  readonly signatureAlgorithm: 'sha256WithRSAEncryption' | 'ecdsa-with-SHA256';
  readonly revoked: readonly RevokedEntry[];
}

export class CertificateRevocationList implements CrlFields {
  readonly version = 2 as const;
  readonly issuer: string;
  readonly thisUpdate: number;
  readonly nextUpdate: number;
  readonly signatureAlgorithm: 'sha256WithRSAEncryption' | 'ecdsa-with-SHA256';
  readonly revoked: readonly RevokedEntry[];
  readonly signature: string;

  private constructor(fields: CrlFields, signature: string) {
    this.issuer = fields.issuer;
    this.thisUpdate = fields.thisUpdate;
    this.nextUpdate = fields.nextUpdate;
    this.signatureAlgorithm = fields.signatureAlgorithm;
    this.revoked = fields.revoked;
    this.signature = signature;
  }

  static tbs(fields: CrlFields): string {
    return JSON.stringify({
      v: fields.version,
      i: fields.issuer,
      tu: fields.thisUpdate,
      nu: fields.nextUpdate,
      alg: fields.signatureAlgorithm,
      r: fields.revoked.map(r => [r.serialNumber, r.revocationDate, r.reasonCode ?? null]),
    });
  }

  /**
   * Reconstruit une CRL LUE quelque part, avec la signature qu'elle
   * porte.
   *
   * `sign()` ne convient pas pour cela : il en fabriquerait une nouvelle,
   * signée par la clé de qui la relit — donc valide pour tout le monde,
   * ce qui viderait `isValidSignature` de son sens. Une CRL venue d'un
   * fichier garde sa signature, bonne ou mauvaise.
   */
  static fromParsed(fields: CrlFields, signature: string): CertificateRevocationList {
    return new CertificateRevocationList(fields, signature);
  }

  static sign(fields: CrlFields, signerKey: { algorithm: 'rsa' | 'ecdsa'; material: string }): CertificateRevocationList {
    const sig = PkiKeyPair.sign(signerKey, CertificateRevocationList.tbs(fields));
    return new CertificateRevocationList(fields, sig);
  }

  isValidSignature(issuerPublicKey: PkiPublicKey): boolean {
    return PkiKeyPair.verify(issuerPublicKey, CertificateRevocationList.tbs({
      version: this.version,
      issuer: this.issuer,
      thisUpdate: this.thisUpdate,
      nextUpdate: this.nextUpdate,
      signatureAlgorithm: this.signatureAlgorithm,
      revoked: this.revoked,
    }), this.signature);
  }

  contains(serialNumber: string): boolean {
    return this.revoked.some(r => r.serialNumber === serialNumber);
  }

  isFresh(now: number): boolean {
    return now <= this.nextUpdate;
  }
}
