import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { selectCipherSuite } from '@/network/tls/cipherSuites';
import { selectAlpnProtocol } from '@/network/tls/alpn';
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

describe('selectCipherSuite (RFC 8446 §4.1.1)', () => {
  it('picks the first suite in server preference order that the client also offered', () => {
    const chosen = selectCipherSuite(
      ['TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_128_GCM_SHA256'],
      ['TLS_AES_256_GCM_SHA384', 'TLS_AES_128_GCM_SHA256'],
    );
    expect(chosen).toBe('TLS_AES_128_GCM_SHA256');
  });

  it('returns null when there is no overlap at all', () => {
    expect(selectCipherSuite(['TLS_AES_128_GCM_SHA256'], ['TLS_AES_256_GCM_SHA384'])).toBeNull();
  });
});

describe('selectAlpnProtocol (RFC 7301)', () => {
  it('picks the first server-preferred protocol the client also offered', () => {
    expect(selectAlpnProtocol(['http/1.1', 'h2'], ['h2', 'http/1.1'])).toBe('h2');
  });

  it('returns null when the client offered nothing', () => {
    expect(selectAlpnProtocol(undefined, ['h2'])).toBeNull();
    expect(selectAlpnProtocol([], ['h2'])).toBeNull();
  });

  it('returns null when there is no overlap', () => {
    expect(selectAlpnProtocol(['spdy/3'], ['h2', 'http/1.1'])).toBeNull();
  });
});

describe('TLS 1.3 session — cipher suite and ALPN negotiation', () => {
  it('negotiates the server-configured suite when the client offers all mandatory suites (default)', () => {
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
    expect(server.negotiatedCipherSuite).toBe('TLS_CHACHA20_POLY1305_SHA256');
    expect(client.negotiatedCipherSuite).toBe('TLS_CHACHA20_POLY1305_SHA256');
  });

  it('falls back to a mutual suite when the client does not offer the server-preferred one', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({
      serverCert: issued.cert, serverPrivateKey: issued.privateKey, cipherSuite: 'TLS_CHACHA20_POLY1305_SHA256',
    });
    const client = new TlsClientSession({ verifier, cipherSuites: ['TLS_AES_128_GCM_SHA256'] });

    runHandshake(client, server);

    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');
    expect(server.negotiatedCipherSuite).toBe('TLS_AES_128_GCM_SHA256');
  });

  it('negotiates ALPN when client and server share a protocol', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({
      serverCert: issued.cert, serverPrivateKey: issued.privateKey, alpnProtocols: ['h2', 'http/1.1'],
    });
    const client = new TlsClientSession({ verifier, alpn: ['http/1.1', 'h2'] });

    runHandshake(client, server);

    expect(client.result).toBe('success');
    expect(server.negotiatedAlpnProtocol).toBe('h2');
    expect(client.negotiatedAlpnProtocol).toBe('h2');
  });

  it('leaves ALPN unnegotiated (null) when the client does not offer any protocol', () => {
    const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
    const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new TlsServerSession({
      serverCert: issued.cert, serverPrivateKey: issued.privateKey, alpnProtocols: ['h2'],
    });
    const client = new TlsClientSession({ verifier });

    runHandshake(client, server);

    expect(client.result).toBe('success');
    expect(server.negotiatedAlpnProtocol).toBeNull();
    expect(client.negotiatedAlpnProtocol).toBeNull();
  });
});
