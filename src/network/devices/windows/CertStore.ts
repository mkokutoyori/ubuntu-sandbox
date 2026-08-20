/**
 * WindowsCertStore — a minimal stand-in for `Cert:\LocalMachine\My`
 * (PRD-Windows-Server-Advanced.md §5 P13/P14): every certificate a device
 * holds a private key for, whether issued by AD CS (`certreq`/`Get-
 * Certificate`) or self-signed (`New-SelfSignedCertificate`), lands here
 * so `New-WebBinding -CertificateHash <thumbprint>` can look either up the
 * same way. `serialNumber` doubles as the lookup key — this simulator's
 * `X509Certificate` doesn't byte-encode DER, so there's no real SHA-1
 * thumbprint to compute, and the serial is already unique per cert.
 */

import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';

export interface StoredCertEntry {
  readonly cert: X509Certificate;
  readonly privateKey: PkiPrivateKey;
}

export class WindowsCertStore {
  private readonly entries = new Map<string, StoredCertEntry>();

  /** Returns the thumbprint (this simulator's serial-number stand-in) the entry was stored under. */
  add(cert: X509Certificate, privateKey: PkiPrivateKey): string {
    this.entries.set(cert.serialNumber, { cert, privateKey });
    return cert.serialNumber;
  }

  get(thumbprint: string): StoredCertEntry | null {
    return this.entries.get(thumbprint) ?? null;
  }

  list(): X509Certificate[] {
    return [...this.entries.values()].map(e => e.cert);
  }
}
