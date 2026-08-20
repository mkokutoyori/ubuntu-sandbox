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

function establishedPair(): { client: TlsClientSession; server: TlsServerSession } {
  const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
  const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

  const server = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey });
  const client = new TlsClientSession({ verifier });
  runHandshake(client, server);

  expect(client.result).toBe('success');
  expect(server.result).toBe('accept');
  return { client, server };
}

describe('TLS 1.3 KeyUpdate (RFC 8446 §4.6.3, §7.2)', () => {
  it('ratchets the client->server secret independently when the client initiates', () => {
    const { client, server } = establishedPair();
    const priorClientSecret = client.clientApplicationTrafficSecret!;
    const priorServerSecret = client.serverApplicationTrafficSecret!;

    const flight = client.sendKeyUpdate();
    const reply = server.receiveKeyUpdate(flight);

    expect(reply).toBeNull();
    expect(client.clientApplicationTrafficSecret).not.toBe(priorClientSecret);
    expect(server.clientApplicationTrafficSecret).toBe(client.clientApplicationTrafficSecret);
    // The other direction's secret is untouched on both sides.
    expect(client.serverApplicationTrafficSecret).toBe(priorServerSecret);
    expect(server.serverApplicationTrafficSecret).toBe(priorServerSecret);
  });

  it('ratchets the server->client secret independently when the server initiates', () => {
    const { client, server } = establishedPair();
    const priorServerSecret = server.serverApplicationTrafficSecret!;
    const priorClientSecret = server.clientApplicationTrafficSecret!;

    const flight = server.sendKeyUpdate();
    const reply = client.receiveKeyUpdate(flight);

    expect(reply).toBeNull();
    expect(server.serverApplicationTrafficSecret).not.toBe(priorServerSecret);
    expect(client.serverApplicationTrafficSecret).toBe(server.serverApplicationTrafficSecret);
    expect(server.clientApplicationTrafficSecret).toBe(priorClientSecret);
    expect(client.clientApplicationTrafficSecret).toBe(priorClientSecret);
  });

  it('reciprocates exactly once when requestUpdate is set, without triggering a ping-pong', () => {
    const { client, server } = establishedPair();

    const request = client.sendKeyUpdate(true);
    const serverReply = server.receiveKeyUpdate(request);
    expect(serverReply).not.toBeNull();

    const clientReplyToReply = client.receiveKeyUpdate(serverReply!);
    expect(clientReplyToReply).toBeNull();

    // Both directions ended up ratcheted, and both sides agree on both secrets.
    expect(server.clientApplicationTrafficSecret).toBe(client.clientApplicationTrafficSecret);
    expect(client.serverApplicationTrafficSecret).toBe(server.serverApplicationTrafficSecret);
  });

  it('ratchets further on each successive KeyUpdate rather than reusing a prior secret', () => {
    const { client, server } = establishedPair();

    const first = client.clientApplicationTrafficSecret;
    server.receiveKeyUpdate(client.sendKeyUpdate());
    const second = client.clientApplicationTrafficSecret;
    server.receiveKeyUpdate(client.sendKeyUpdate());
    const third = client.clientApplicationTrafficSecret;

    expect(new Set([first, second, third]).size).toBe(3);
    expect(server.clientApplicationTrafficSecret).toBe(third);
  });
});
