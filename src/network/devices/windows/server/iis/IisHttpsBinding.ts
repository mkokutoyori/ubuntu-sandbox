/**
 * IisHttpsBinding — the certificate-carrying half of an IIS site's HTTPS
 * listener (PRD-Windows-Server-Advanced.md §5 P14, §2.1.14). Zero new TLS
 * primitive: `HttpsServerSession`/`TlsServerSession` (already delivered by
 * `PRD-TLS.md`/`PRD-HTTP.md`) are reused exactly as FTPS already reused
 * them for a different protocol (`PRD-FTP-SFTP.md` P8) — this module only
 * turns a `WindowsCertStore` lookup into the `HttpsServerConfig` that
 * session needs.
 */

import type { StoredCertEntry } from '@/network/devices/windows/CertStore';
import type { HttpsServerConfig } from '@/network/http/https/HttpsServerSession';

export function buildHttpsServerConfig(entry: StoredCertEntry): HttpsServerConfig {
  return { serverCert: entry.cert, serverPrivateKey: entry.privateKey };
}
