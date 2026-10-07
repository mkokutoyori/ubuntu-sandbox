import type { PkiPublicKey } from './PkiKeyPair';
import { PkiKeyPair } from './PkiKeyPair';
import { sameSerial, canonicalSerial } from './der/X509Der';
import { canonicalDistinguishedName } from './der/DistinguishedName';
import { tbsBytesOfCrl, rememberReceivedTbs } from './der/CrlDer';

export interface RevokedEntry {
  readonly serialNumber: string;
  readonly revocationDate: number;
  readonly reasonCode?: 'unspecified' | 'keyCompromise' | 'cACompromise' | 'affiliationChanged' | 'superseded' | 'cessationOfOperation' | 'certificateHold' | 'removeFromCRL';
}

export interface CrlFields {
  readonly version: 2;
  readonly issuer: string;
  readonly thisUpdate: number;
  readonly nextUpdate: number;
  readonly signatureAlgorithm: 'sha256WithRSAEncryption' | 'ecdsa-with-SHA256';
  readonly revoked: readonly RevokedEntry[];
  readonly crlNumber?: number;
  readonly authorityKeyIdentifier?: string;
}

export class CertificateRevocationList implements CrlFields {
  readonly version = 2 as const;
  readonly issuer: string;
  readonly thisUpdate: number;
  readonly nextUpdate: number;
  readonly signatureAlgorithm: 'sha256WithRSAEncryption' | 'ecdsa-with-SHA256';
  readonly revoked: readonly RevokedEntry[];
  readonly crlNumber?: number;
  readonly authorityKeyIdentifier?: string;
  readonly signature: string;

  private constructor(fields: CrlFields, signature: string) {
    this.issuer = fields.issuer;
    this.thisUpdate = fields.thisUpdate;
    this.nextUpdate = fields.nextUpdate;
    this.signatureAlgorithm = fields.signatureAlgorithm;
    this.revoked = fields.revoked;
    if (fields.crlNumber !== undefined) this.crlNumber = fields.crlNumber;
    if (fields.authorityKeyIdentifier !== undefined) this.authorityKeyIdentifier = fields.authorityKeyIdentifier;
    this.signature = signature;
  }

  static normalize(fields: CrlFields): CrlFields {
    return {
      ...fields,
      issuer: canonicalDistinguishedName(fields.issuer),
      thisUpdate: Math.floor(fields.thisUpdate / 1000) * 1000,
      nextUpdate: Math.floor(fields.nextUpdate / 1000) * 1000,
      revoked: fields.revoked.map((entry) => ({
        ...entry,
        serialNumber: canonicalSerial(entry.serialNumber),
        revocationDate: Math.floor(entry.revocationDate / 1000) * 1000,
      })),
    };
  }

  static tbs(fields: CrlFields): Uint8Array {
    return tbsBytesOfCrl(fields);
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
  static fromParsed(fields: CrlFields, signature: string, receivedTbs?: Uint8Array): CertificateRevocationList {
    const crl = new CertificateRevocationList(fields, signature);
    if (receivedTbs) rememberReceivedTbs(crl, receivedTbs);
    return crl;
  }

  static sign(fields: CrlFields, signerKey: { algorithm: 'rsa' | 'ecdsa'; material: string }): CertificateRevocationList {
    const normalized = CertificateRevocationList.normalize(fields);
    const sig = PkiKeyPair.sign(signerKey, CertificateRevocationList.tbs(normalized));
    return new CertificateRevocationList(normalized, sig);
  }

  isValidSignature(issuerPublicKey: PkiPublicKey): boolean {
    return PkiKeyPair.verify(issuerPublicKey, tbsBytesOfCrl(this), this.signature);
  }

  contains(serialNumber: string): boolean {
    return this.revoked.some(r => r.reasonCode !== 'removeFromCRL' && sameSerial(r.serialNumber, serialNumber));
  }

  isFresh(now: number): boolean {
    return now <= this.nextUpdate;
  }
}
