/**
 * WindowsCertStore — a minimal stand-in for `Cert:\LocalMachine\My`
 * (PRD-Windows-Server-Advanced.md §5 P13/P14): every certificate a device
 * holds a private key for, whether issued by AD CS (`certreq`/`Get-
 * Certificate`) or self-signed (`New-SelfSignedCertificate`), lands here
 * so `New-WebBinding -CertificateHash <thumbprint>` can look either up the
 * same way. The lookup key is the certificate's SHA-1 thumbprint.
 */

import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import { certificateThumbprint } from '@/network/pki/thumbprint';

export interface StoredCertEntry {
  readonly cert: X509Certificate;
  readonly privateKey: PkiPrivateKey;
}

export class WindowsCertStore {
  private readonly entries = new Map<string, StoredCertEntry>();

  add(cert: X509Certificate, privateKey: PkiPrivateKey): string {
    const thumbprint = certificateThumbprint(cert);
    this.entries.set(thumbprint, { cert, privateKey });
    return thumbprint;
  }

  get(thumbprint: string): StoredCertEntry | null {
    return this.entries.get(thumbprint.toUpperCase()) ?? null;
  }

  remove(thumbprint: string): boolean {
    return this.entries.delete(thumbprint.toUpperCase());
  }

  entriesSnapshot(): StoredCertEntry[] {
    return [...this.entries.values()];
  }

  list(): X509Certificate[] {
    return [...this.entries.values()].map(e => e.cert);
  }
}
