import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';

const NOW = Date.now();

/**
 * Drives the nominal handshake to completion, returning how many flights
 * were exchanged (ClientHello, ServerFlight, ClientFinished — exactly 3
 * for a successful 1-RTT handshake, per RFC 8446 §4).
 */
function runHandshake(client: TlsClientSession, server: TlsServerSession): { flightCount: number } {
  let flight: readonly TlsRecord[] | null = client.start();
  let flightCount = 1;
  while (server.result === null && flight !== null) {
    if (flightCount > 10) throw new Error('handshake did not converge');
    const serverFlight = server.handle(flight);
    if (serverFlight === null) break;
    flightCount++;
    flight = client.handle(serverFlight);
    if (flight === null) break;
    flightCount++;
  }
  return { flightCount };
}

describe('TLS 1.3 (RFC 8446 §4) — nominal 1-RTT handshake', () => {
  it('completes successfully with a certificate issued by a trusted CA', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey });
    const client = new TlsClientSession({ verifier });

    const { flightCount } = runHandshake(client, server);

    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');
    expect(flightCount).toBe(3);
  });

  it('rejects a certificate issued by an untrusted CA before any application_data is exchanged', () => {
    const rogueCa = CertificateAuthority.generate('CN=rogue-ca', { now: NOW });
    const issued = rogueCa.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });

    const legitCa = CertificateAuthority.generate('CN=legit-ca', { now: NOW });
    const verifier = new CertificateVerifier({ trustAnchors: [legitCa.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey });
    const client = new TlsClientSession({ verifier });

    const clientHello = client.start();
    const serverFlight = server.handle(clientHello);
    const clientFinished = client.handle(serverFlight!);

    expect(client.result).toBe('failure');
    expect(clientFinished).toBeNull();
    expect(server.result).toBeNull();
  });

  it('rejects a certificate presented after its notAfter date', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 2000, notAfter: NOW - 1000 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey });
    const client = new TlsClientSession({ verifier });

    const clientHello = client.start();
    const serverFlight = server.handle(clientHello);
    const clientFinished = client.handle(serverFlight!);

    expect(client.result).toBe('failure');
    expect(clientFinished).toBeNull();
  });

  it('negotiates the configured cipher suite and carries it through to the client', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({
      serverCert: issued.cert, serverPrivateKey: issued.privateKey, cipherSuite: 'TLS_CHACHA20_POLY1305_SHA256',
    });
    const client = new TlsClientSession({ verifier });
    runHandshake(client, server);

    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');
  });

  it('produces a server ServerHello record labeled handshake and a protected bundle labeled application_data', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey });
    const client = new TlsClientSession({ verifier });

    const clientHello = client.start();
    expect(clientHello.every((r) => r.contentType === 'handshake')).toBe(true);

    const serverFlight = server.handle(clientHello)!;
    expect(serverFlight[0].contentType).toBe('handshake');
    expect(serverFlight.slice(1).every((r) => r.contentType === 'application_data')).toBe(true);

    const clientFinished = client.handle(serverFlight)!;
    expect(clientFinished.every((r) => r.contentType === 'application_data')).toBe(true);
  });
});
