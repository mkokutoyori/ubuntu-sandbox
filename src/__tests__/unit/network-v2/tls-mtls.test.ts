import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';

const NOW = Date.now();

function runHandshake(client: TlsClientSession, server: TlsServerSession): void {
  let flight: readonly TlsRecord[] | null = client.start();
  let rounds = 0;
  while (server.result === null && flight !== null) {
    if (rounds++ > 10) throw new Error('handshake did not converge');
    const serverFlight = server.handle(flight);
    if (serverFlight === null) break;
    flight = client.handle(serverFlight);
  }
}

describe('TLS 1.3 mutual authentication (mTLS, RFC 8446 §4.3.2/§4.4.2)', () => {
  it('authenticates both server and client when both present valid certificates', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const serverIssued = ca.issueCertificate({ subject: 'CN=server.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const clientIssued = ca.issueCertificate({ subject: 'CN=client.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({
      serverCert: serverIssued.cert, serverPrivateKey: serverIssued.privateKey,
      requestClientCert: true, verifier,
    });
    const client = new TlsClientSession({
      verifier, clientCert: clientIssued.cert, clientPrivateKey: clientIssued.privateKey,
    });

    runHandshake(client, server);

    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');
  });

  it('rejects when the server requests a client certificate but the client presents none', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const serverIssued = ca.issueCertificate({ subject: 'CN=server.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({
      serverCert: serverIssued.cert, serverPrivateKey: serverIssued.privateKey,
      requestClientCert: true, verifier,
    });
    const client = new TlsClientSession({ verifier });

    runHandshake(client, server);

    expect(client.result).toBe('success');
    expect(server.result).toBe('reject');
  });

  it('rejects a client certificate issued by an untrusted CA', () => {
    const serverCa = CertificateAuthority.generate('CN=server-ca', { now: NOW });
    const serverIssued = serverCa.issueCertificate({ subject: 'CN=server.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const serverVerifier = new CertificateVerifier({ trustAnchors: [serverCa.rootCertificate], clock: () => NOW });

    const rogueCa = CertificateAuthority.generate('CN=rogue-ca', { now: NOW });
    const rogueClientIssued = rogueCa.issueCertificate({ subject: 'CN=client.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });

    const server = new TlsServerSession({
      serverCert: serverIssued.cert, serverPrivateKey: serverIssued.privateKey,
      requestClientCert: true, verifier: serverVerifier,
    });
    const client = new TlsClientSession({
      verifier: serverVerifier, clientCert: rogueClientIssued.cert, clientPrivateKey: rogueClientIssued.privateKey,
    });

    runHandshake(client, server);

    expect(client.result).toBe('success');
    expect(server.result).toBe('reject');
  });

  it('does not request a client certificate by default (backward compatible with P3)', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const serverIssued = ca.issueCertificate({ subject: 'CN=server.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({ serverCert: serverIssued.cert, serverPrivateKey: serverIssued.privateKey });
    const client = new TlsClientSession({ verifier });

    runHandshake(client, server);

    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');
  });
});
