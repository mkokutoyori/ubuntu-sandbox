import { describe, it, expect } from 'vitest';
import { utf8ToBytes, bytesToUtf8 } from '@/crypto/encoding';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { SessionTicketStore } from '@/network/tls/sessionTickets';
import type { TlsRecord } from '@/network/tls/recordLayer';

const NOW = Date.now();

function runFullHandshake(
  client: TlsClientSession, server: TlsServerSession,
): { finalServerFlight: readonly TlsRecord[] | null } {
  let flight: readonly TlsRecord[] | null = client.start();
  let finalServerFlight: readonly TlsRecord[] | null = null;
  let rounds = 0;
  while (server.result === null && flight !== null) {
    if (rounds++ > 10) throw new Error('handshake did not converge');
    const serverFlight = server.handle(flight);
    finalServerFlight = serverFlight;
    if (serverFlight === null) break;
    flight = client.handle(serverFlight);
  }
  return { finalServerFlight };
}

function setUpCa() {
  const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
  const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  return { issued, verifier };
}

function newServer(
  issued: ReturnType<typeof setUpCa>['issued'], store?: SessionTicketStore,
): TlsServerSession {
  return new TlsServerSession({
    serverCert: issued.cert, serverPrivateKey: issued.privateKey, sessionTicketStore: store,
  });
}

describe('TLS 1.3 session tickets (RFC 8446 §4.6.1)', () => {
  it('issues a ticket after a full handshake when a session ticket store is configured', () => {
    const store = new SessionTicketStore();
    const { issued, verifier } = setUpCa();
    const server = newServer(issued, store);
    const client = new TlsClientSession({ verifier });

    let flight: readonly TlsRecord[] | null = client.start();
    const serverFlight1 = server.handle(flight)!;
    flight = client.handle(serverFlight1);
    const ticketFlight = server.handle(flight!);

    expect(server.result).toBe('accept');
    expect(client.result).toBe('success');
    expect(ticketFlight).not.toBeNull();

    client.receiveSessionTicket(ticketFlight!);
    expect(client.receivedTicket).not.toBeNull();
    expect(client.receivedTicket!.ticket).toBeTruthy();
  });

  it('does not issue a ticket when no session ticket store is configured', () => {
    const { issued, verifier } = setUpCa();
    const server = newServer(issued, undefined);
    const client = new TlsClientSession({ verifier });
    const { finalServerFlight } = runFullHandshake(client, server);
    expect(finalServerFlight).toBeNull();
  });
});

describe('TLS 1.3 PSK resumption and 0-RTT (RFC 8446 §4.2.11, §2.3)', () => {
  it('resumes a session with the issued ticket on a fresh client/server pair', () => {
    const store = new SessionTicketStore();
    const { issued, verifier } = setUpCa();
    const server1 = newServer(issued, store);
    const client1 = new TlsClientSession({ verifier });

    let flight: readonly TlsRecord[] | null = client1.start();
    const serverFlight1 = server1.handle(flight)!;
    flight = client1.handle(serverFlight1);
    const ticketFlight = server1.handle(flight!);
    client1.receiveSessionTicket(ticketFlight!);
    const ticket = client1.receivedTicket!;

    const server2 = newServer(issued, store);
    const client2 = new TlsClientSession({ verifier, resumptionTicket: ticket });
    runFullHandshake(client2, server2);

    expect(client2.result).toBe('success');
    expect(server2.result).toBe('accept');
  });

  it('delivers 0-RTT early data to the server when the ticket is valid', () => {
    const store = new SessionTicketStore();
    const { issued, verifier } = setUpCa();
    const server1 = newServer(issued, store);
    const client1 = new TlsClientSession({ verifier });

    let flight: readonly TlsRecord[] | null = client1.start();
    const serverFlight1 = server1.handle(flight)!;
    flight = client1.handle(serverFlight1);
    const ticketFlight = server1.handle(flight!);
    client1.receiveSessionTicket(ticketFlight!);
    const ticket = client1.receivedTicket!;

    const server2 = newServer(issued, store);
    const client2 = new TlsClientSession({
      verifier, resumptionTicket: ticket, earlyData: utf8ToBytes('GET /early HTTP/1.1'),
    });
    const clientHelloWithEarlyData = client2.start();
    server2.handle(clientHelloWithEarlyData);

    expect(server2.receivedEarlyData).not.toBeNull();
    expect(bytesToUtf8(server2.receivedEarlyData!)).toBe('GET /early HTTP/1.1');
  });

  it('falls back to a full handshake without early data when the ticket has already been consumed', () => {
    const store = new SessionTicketStore();
    const { issued, verifier } = setUpCa();
    const server1 = newServer(issued, store);
    const client1 = new TlsClientSession({ verifier });

    let flight: readonly TlsRecord[] | null = client1.start();
    const serverFlight1 = server1.handle(flight)!;
    flight = client1.handle(serverFlight1);
    const ticketFlight = server1.handle(flight!);
    client1.receiveSessionTicket(ticketFlight!);
    const ticket = client1.receivedTicket!;

    // First redemption succeeds and consumes the ticket.
    expect(store.redeem(ticket.ticket, Date.now())).not.toBeNull();

    const server2 = newServer(issued, store);
    const client2 = new TlsClientSession({
      verifier, resumptionTicket: ticket, earlyData: utf8ToBytes('should not be accepted'),
    });
    runFullHandshake(client2, server2);

    expect(client2.result).toBe('success');
    expect(server2.result).toBe('accept');
    expect(server2.receivedEarlyData).toBeNull();
  });

  it('falls back to a full handshake when the ticket has expired', () => {
    const store = new SessionTicketStore();
    store.issue({
      ticket: 'expired-ticket', resumptionMasterSecret: 'irrelevant', ticketNonce: 'n',
      cipherSuite: 'TLS_AES_128_GCM_SHA256', ticketLifetime: 1, issuedAt: NOW - 10_000, consumed: false,
    });
    const { issued, verifier } = setUpCa();
    const server = newServer(issued, store);
    const client = new TlsClientSession({
      verifier,
      resumptionTicket: {
        ticket: 'expired-ticket', resumptionMasterSecret: 'irrelevant', ticketNonce: 'n',
        cipherSuite: 'TLS_AES_128_GCM_SHA256', ticketLifetime: 1, issuedAt: NOW - 10_000, consumed: false,
      },
      earlyData: utf8ToBytes('should not be accepted'),
    });

    runFullHandshake(client, server);

    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');
    expect(server.receivedEarlyData).toBeNull();
  });
});
