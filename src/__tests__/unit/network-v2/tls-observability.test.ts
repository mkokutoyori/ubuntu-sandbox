import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { SessionTicketStore } from '@/network/tls/sessionTickets';
import { TlsSignalStore, subscribeTlsObservables } from '@/network/tls/observables';
import type { TlsDomainEvent } from '@/network/tls/events';
import { EventBus } from '@/events/EventBus';
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

function setUpCa() {
  const ca = CertificateAuthority.generate('CN=test-ca', { now: NOW });
  const issued = ca.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  return { issued, verifier };
}

function newServer(
  issued: ReturnType<typeof setUpCa>['issued'], extra: Partial<TlsServerConfig> = {},
): TlsServerSession {
  return new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey, ...extra });
}

describe('TLS 1.3 observability (RFC 8446 §2.1.12, events.ts)', () => {
  it('publishes matching handshake.started/completed events for both sides on success', () => {
    const bus = new EventBus();
    const events: TlsDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as TlsDomainEvent));

    const { issued, verifier } = setUpCa();
    const server = newServer(issued, { eventBus: bus });
    const client = new TlsClientSession({ verifier, eventBus: bus });
    runHandshake(client, server);

    expect(client.result).toBe('success');
    expect(server.result).toBe('accept');

    const topics = events.map((e) => e.topic);
    expect(topics.filter((t) => t === 'tls.handshake.started')).toHaveLength(2);
    expect(topics.filter((t) => t === 'tls.handshake.completed')).toHaveLength(2);

    const clientCompleted = events.find(
      (e): e is Extract<TlsDomainEvent, { topic: 'tls.handshake.completed' }> =>
        e.topic === 'tls.handshake.completed' && e.payload.role === 'client',
    );
    expect(clientCompleted?.payload.resumed).toBe(false);
    expect(clientCompleted?.payload.cipherSuite).toBe(server.negotiatedCipherSuite);
  });

  it('publishes handshake.failed and alert.sent when the client rejects the server certificate', () => {
    const bus = new EventBus();
    const events: TlsDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as TlsDomainEvent));

    const rogueCa = CertificateAuthority.generate('CN=rogue-ca', { now: NOW });
    const issued = rogueCa.issueCertificate({ subject: 'CN=example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const legitCa = CertificateAuthority.generate('CN=legit-ca', { now: NOW });
    const verifier = new CertificateVerifier({ trustAnchors: [legitCa.rootCertificate], clock: () => NOW });

    const server = newServer(issued, { eventBus: bus });
    const client = new TlsClientSession({ verifier, eventBus: bus });

    const clientHello = client.start();
    const serverFlight = server.handle(clientHello)!;
    client.handle(serverFlight);

    expect(client.result).toBe('failure');
    const failed = events.find((e) => e.topic === 'tls.handshake.failed');
    const alertSent = events.find((e) => e.topic === 'tls.alert.sent');
    expect(failed).toBeDefined();
    expect(alertSent).toBeDefined();
    if (failed?.topic === 'tls.handshake.failed') expect(failed.payload.alert.description).toBe('unknown_ca');
  });

  it('publishes session.resumed on both sides once a ticket is redeemed', () => {
    const store = new SessionTicketStore();
    const { issued, verifier } = setUpCa();

    const server1 = newServer(issued, { sessionTicketStore: store });
    const client1 = new TlsClientSession({ verifier });
    let flight: readonly TlsRecord[] | null = client1.start();
    const serverFlight1 = server1.handle(flight)!;
    flight = client1.handle(serverFlight1);
    const ticketFlight = server1.handle(flight!);
    client1.receiveSessionTicket(ticketFlight!);
    const ticket = client1.receivedTicket!;

    const bus = new EventBus();
    const events: TlsDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as TlsDomainEvent));

    const server2 = newServer(issued, { sessionTicketStore: store, eventBus: bus });
    const client2 = new TlsClientSession({ verifier, resumptionTicket: ticket, eventBus: bus });
    runHandshake(client2, server2);

    expect(client2.result).toBe('success');
    expect(server2.result).toBe('accept');
    const resumedTopics = events.filter((e) => e.topic === 'tls.session.resumed');
    expect(resumedTopics).toHaveLength(2);
    expect(resumedTopics.map((e) => e.payload.role).sort()).toEqual(['client', 'server']);
  });

  it('feeds a TlsSignalStore from the bus and reflects handshake completion', () => {
    const bus = new EventBus();
    const store = new TlsSignalStore();
    const unsubscribe = subscribeTlsObservables(bus, store);

    const { issued, verifier } = setUpCa();
    const server = newServer(issued, { eventBus: bus });
    const client = new TlsClientSession({ verifier, eventBus: bus });
    runHandshake(client, server);

    const sessions = store.sessions.get();
    expect(sessions).toHaveLength(2);
    const clientVM = sessions.find((s) => s.role === 'client');
    expect(clientVM?.status).toBe('established');
    expect(clientVM?.cipherSuite).toBe(client.negotiatedCipherSuite);

    unsubscribe();
  });

  it('increments keyUpdateCount in the signal store on each KeyUpdate, independently per role', () => {
    const bus = new EventBus();
    const store = new TlsSignalStore();
    subscribeTlsObservables(bus, store);

    const { issued, verifier } = setUpCa();
    const server = newServer(issued, { eventBus: bus });
    const client = new TlsClientSession({ verifier, eventBus: bus });
    runHandshake(client, server);

    server.receiveKeyUpdate(client.sendKeyUpdate());
    server.receiveKeyUpdate(client.sendKeyUpdate());

    const clientVM = store.sessions.get().find((s) => s.role === 'client');
    const serverVM = store.sessions.get().find((s) => s.role === 'server');
    expect(clientVM?.keyUpdateCount).toBe(2);
    expect(serverVM?.keyUpdateCount).toBe(2);
  });
});
