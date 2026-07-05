/**
 * PRD-QUIC.md §5 P9 — 0-RTT (RFC 9001 §4.4). Per the PRD: "reuses the
 * 0-RTT already planned by the TLS engine entirely, no QUIC-specific
 * replay logic". Validates that P8's existing Initial-space CRYPTO
 * transport already carries 0-RTT data end-to-end without any further
 * QUIC-layer change: `TlsClientSession.start()` bundles early data as an
 * extra `TlsRecord` inside the same flight, and
 * `TlsServerSession.handleFirstClientHello` already splits ClientHello
 * from that trailing record — exactly the same array P8's
 * `sendCryptoRecords('initial', flight)` sends and the server already
 * decodes before calling `tls.handle()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { EndHost } from '@/network/devices/EndHost';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { SessionTicketStore } from '@/network/tls/sessionTickets';
import { QuicConnection } from '@/network/quic/QuicConnection';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

const NOW = Date.now();
const CLIENT_DEST_CONNECTION_ID = 'ee00ff11';
const PORT = 9743;

function topology(tag: string, thirdOctet: string) {
  const server = new LinuxPC('linux-pc', `Q0SRV${tag}`);
  const client = new LinuxPC('linux-pc', `Q0CLI${tag}`);
  const sw = new GenericSwitch('switch-generic', `SW${tag}`);
  new Cable(`c1${tag}`).connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable(`c2${tag}`).connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  const serverIp = `192.168.${thirdOctet}.10`;
  server.getPorts()[0].configureIP(new IPAddress(serverIp), mask);
  client.getPorts()[0].configureIP(new IPAddress(`192.168.${thirdOctet}.20`), mask);
  return { server: server as unknown as EndHost, client: client as unknown as EndHost, serverIp };
}

function setUpCa() {
  const ca = CertificateAuthority.generate('CN=quic-0rtt-test-ca', { now: NOW });
  const issued = ca.issueCertificate({ subject: 'CN=quic-0rtt.example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  return { issued, verifier };
}

function connectOverQuic(
  server: EndHost, client: EndHost, serverIp: string, serverTls: TlsServerSession, clientTls: TlsClientSession,
) {
  const serverConn = new QuicConnection(server, 'server', PORT, {
    mode: 'tls', tls: serverTls, clientDestConnectionId: CLIENT_DEST_CONNECTION_ID,
  });
  const clientConn = new QuicConnection(client, 'client', PORT, {
    mode: 'tls', tls: clientTls, clientDestConnectionId: CLIENT_DEST_CONNECTION_ID,
  });
  clientConn.connect(serverIp, PORT);
  return { serverConn, clientConn };
}

describe('QUIC 0-RTT (RFC 9001 §4.4) — reuses the TLS engine 0-RTT as-is', () => {
  it('delivers 0-RTT early data to the server on a resumed QUIC/TLS connection', () => {
    const store = new SessionTicketStore();
    const { issued, verifier } = setUpCa();

    // First connection: full real handshake over QUIC, server issues a session ticket
    // (also delivered over QUIC, via the Handshake-space CRYPTO flight P8 already sends).
    const t1 = topology('a', '103');
    const server1Tls = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey, sessionTicketStore: store });
    const client1Tls = new TlsClientSession({ verifier });
    connectOverQuic(t1.server, t1.client, t1.serverIp, server1Tls, client1Tls);

    expect(client1Tls.result).toBe('success');
    expect(server1Tls.result).toBe('accept');
    expect(client1Tls.receivedTicket).not.toBeNull();

    // Second connection: resume with the ticket, offering 0-RTT early data.
    const t2 = topology('b', '104');
    const server2Tls = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey, sessionTicketStore: store });
    const client2Tls = new TlsClientSession({
      verifier, resumptionTicket: client1Tls.receivedTicket!, earlyData: new TextEncoder().encode('GET /early HTTP/1.1'),
    });
    connectOverQuic(t2.server, t2.client, t2.serverIp, server2Tls, client2Tls);

    expect(client2Tls.result).toBe('success');
    expect(server2Tls.result).toBe('accept');
    expect(server2Tls.receivedEarlyData).not.toBeNull();
    expect(new TextDecoder().decode(server2Tls.receivedEarlyData!)).toBe('GET /early HTTP/1.1');
    expect(client2Tls.earlyDataAccepted).toBe(true);
  });

  it('falls back to a full handshake without early data when the ticket has already been consumed', () => {
    const store = new SessionTicketStore();
    const { issued, verifier } = setUpCa();

    const t1 = topology('c', '105');
    const server1Tls = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey, sessionTicketStore: store });
    const client1Tls = new TlsClientSession({ verifier });
    connectOverQuic(t1.server, t1.client, t1.serverIp, server1Tls, client1Tls);
    const ticket = client1Tls.receivedTicket!;

    // Consume the ticket out of band (as if a previous 0-RTT connection already redeemed it).
    expect(store.redeem(ticket.ticket, Date.now())).not.toBeNull();

    const t2 = topology('d', '106');
    const server2Tls = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey, sessionTicketStore: store });
    const client2Tls = new TlsClientSession({
      verifier, resumptionTicket: ticket, earlyData: new TextEncoder().encode('should not be accepted'),
    });
    connectOverQuic(t2.server, t2.client, t2.serverIp, server2Tls, client2Tls);

    expect(client2Tls.result).toBe('success');
    expect(server2Tls.result).toBe('accept');
    expect(server2Tls.receivedEarlyData).toBeNull();
  });
});
