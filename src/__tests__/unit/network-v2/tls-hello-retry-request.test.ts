import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { HELLO_RETRY_REQUEST_RANDOM } from '@/network/tls/types';
import type { TlsRecord } from '@/network/tls/recordLayer';

const NOW = Date.now();

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

describe('TLS 1.3 HelloRetryRequest (RFC 8446 §4.1.4)', () => {
  it('sends a HelloRetryRequest when the client offers a group the server does not support, and completes after a second ClientHello', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({
      serverCert: issued.cert, serverPrivateKey: issued.privateKey, supportedGroups: ['secp256r1'],
    });
    const client = new TlsClientSession({ verifier, supportedGroups: ['x25519', 'secp256r1'] });

    const { flightCount } = runHandshake(client, server);

    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');
    // ClientHello1, HelloRetryRequest, ClientHello2, ServerFlight, ClientFinished = 5 flights.
    expect(flightCount).toBe(5);
  });

  it('the HelloRetryRequest carries the RFC 8446 §4.1.3 magic random and the selected group', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({
      serverCert: issued.cert, serverPrivateKey: issued.privateKey, supportedGroups: ['secp256r1'],
    });
    const client = new TlsClientSession({ verifier, supportedGroups: ['x25519', 'secp256r1'] });

    const clientHello1 = client.start();
    const hrrFlight = server.handle(clientHello1)!;
    expect(hrrFlight).toHaveLength(1);
    expect(hrrFlight[0].contentType).toBe('handshake');

    const decoded = JSON.parse(new TextDecoder().decode(hrrFlight[0].fragment));
    expect(decoded.kind).toBe('hello_retry_request');
    expect(decoded.random).toBe(HELLO_RETRY_REQUEST_RANDOM);
    expect(decoded.selectedGroup).toBe('secp256r1');
  });

  it('rejects when the client has no group in common with the server at all', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({
      serverCert: issued.cert, serverPrivateKey: issued.privateKey, supportedGroups: ['secp384r1'],
    });
    const client = new TlsClientSession({ verifier, supportedGroups: ['x25519', 'secp256r1'] });

    const clientHello1 = client.start();
    const serverFlight = server.handle(clientHello1);

    expect(serverFlight).toBeNull();
    expect(server.result).toBe('reject');
  });

  it('proceeds normally (no HRR) when the client already offers a group the server supports', () => {
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
});
