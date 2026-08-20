/**
 * LDAP StartTLS (RFC 4511 §4.14.1) — an in-place TLS 1.3 upgrade of an
 * already-open LDAP connection, exactly like FTPS's `AUTH TLS`
 * (`network/ftp/ftps.ts`) reusing the same `TlsClientSession`/
 * `TlsServerSession` engine (PRD-TLS.md). LDAP's socket already carries
 * raw `Uint8Array`s (unlike FTP's string-based control channel), so no
 * `bytesToBinaryString` conversion is needed here.
 */
import type { TcpSocket } from '@/network/tcp/TcpStack';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession, type TlsClientConfig } from '@/network/tls/TlsClientSession';
import { encodeRecords, decodeRecords } from '@/network/http/https/TlsRecordWire';
import { PkiKeyPair } from '@/network/pki/PkiKeyPair';
import { tbsPayload, type X509Certificate } from '@/network/pki/X509Certificate';

/** A minimal self-signed leaf certificate for a DC's own StartTLS listener — no CA chain (PRD-Windows-Server-Advanced.md §5 P11 doesn't need one; a full AD CS chain is §5 P13's job). */
export function selfSignedLdapCert(subject: string): { cert: X509Certificate; keyPair: PkiKeyPair } {
  const keyPair = PkiKeyPair.generate('rsa');
  const fields = {
    version: 3 as const, serialNumber: '1', subject, issuer: subject,
    notBefore: Date.now() - 1000, notAfter: Date.now() + 365 * 24 * 3600 * 1000,
    publicKey: keyPair.publicKey, signatureAlgorithm: 'sha256WithRSAEncryption' as const,
  };
  const signature = PkiKeyPair.sign(keyPair.privateKey, tbsPayload(fields));
  return { cert: { ...fields, signature }, keyPair };
}

/** Feeds one incoming wire chunk into an in-progress server-side handshake and sends back any reply flight. */
export function stepServerHandshake(tls: TlsServerSession, socket: TcpSocket, data: Uint8Array): void {
  const incoming = decodeRecords(data);
  const nextFlight = tls.handle(incoming);
  if (nextFlight && nextFlight.length > 0) socket.send(encodeRecords(nextFlight));
}

/**
 * Client side: drives the full handshake synchronously over `socket`,
 * matching this simulator's synchronous request/reply TCP model (the
 * same pattern `LdapClient`/`KerberosClient`'s `roundTrip` already use).
 * Returns the established session, or `null` if it didn't complete.
 */
export function driveClientHandshake(socket: TcpSocket, config: TlsClientConfig): TlsClientSession | null {
  const tls = new TlsClientSession(config);
  let flight = tls.start();
  for (let i = 0; i < 10; i++) {
    let reply: Uint8Array | null = null;
    const unsubscribe = socket.onData((data) => { if (data instanceof Uint8Array) reply = data; });
    socket.send(encodeRecords(flight));
    unsubscribe();
    // The flight just sent may itself be the client's closing message (its
    // own `Finished`, computed from the *previous* iteration's reply) — once
    // `result` is set there's nothing further to send or wait for.
    if (tls.result !== null) break;
    if (!reply) return null;
    const nextFlight = tls.handle(decodeRecords(reply));
    if (!nextFlight) break;
    flight = nextFlight;
  }
  return tls.result === 'success' ? tls : null;
}
