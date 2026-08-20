/**
 * PRD-QUIC.md §5 P8 — real TLS 1.3 integration (RFC 9001): the Initial
 * ClientHello/ServerHello exchange, the protected Handshake-space
 * EncryptedExtensions/Certificate/Finished bundle, and the transition to
 * 1-RTT (Application space) once the handshake completes — all driven by
 * real `TlsClientSession`/`TlsServerSession` instances (`PRD-TLS.md`)
 * instead of P3-P7's PING/HANDSHAKE_DONE stand-in. Nominal 1-RTT flow
 * only (no HelloRetryRequest) — an explicit simplification of this phase.
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
import { QuicConnection, type QuicMessage } from '@/network/quic/QuicConnection';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

const NOW = Date.now();

function topology() {
  const server = new LinuxPC('linux-pc', 'QTLSSRV');
  const client = new LinuxPC('linux-pc', 'QTLSCLIENT');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.101.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.101.20'), mask);
  return { server: server as unknown as EndHost, client: client as unknown as EndHost };
}

function issueServerCert() {
  const ca = CertificateAuthority.generate('CN=quic-tls-test-ca', { now: NOW });
  const issued = ca.issueCertificate({ subject: 'CN=quic.example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  return { issued, verifier };
}

const PORT = 9643;
const CLIENT_DEST_CONNECTION_ID = 'aabbccdd';

function connectPair(server: EndHost, client: EndHost, verifier: CertificateVerifier, issued: ReturnType<typeof issueServerCert>['issued']) {
  const serverTls = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey });
  const clientTls = new TlsClientSession({ verifier });

  const serverConn = new QuicConnection(server, 'server', PORT, {
    mode: 'tls', tls: serverTls, clientDestConnectionId: CLIENT_DEST_CONNECTION_ID,
  });
  const clientConn = new QuicConnection(client, 'client', PORT, {
    mode: 'tls', tls: clientTls, clientDestConnectionId: CLIENT_DEST_CONNECTION_ID,
  });
  clientConn.connect('192.168.101.10', PORT);
  return { serverConn, clientConn, serverTls, clientTls };
}

describe('QuicConnection — real TLS 1.3 handshake (RFC 9001, nominal 1-RTT)', () => {
  it('both sides reach established after a real Initial -> Handshake -> 1-RTT exchange', () => {
    const { server, client } = topology();
    const { verifier, issued } = issueServerCert();
    const { serverConn, clientConn, serverTls, clientTls } = connectPair(server, client, verifier, issued);

    expect(clientConn.state).toBe('established');
    expect(serverConn.state).toBe('established');
    expect(clientTls.result).toBe('success');
    expect(serverTls.result).toBe('accept');
  });

  it('rejects a handshake against a certificate issued by an untrusted CA, never reaching established', () => {
    const { server, client } = topology();
    const { issued } = issueServerCert();
    const rogueCa = CertificateAuthority.generate('CN=rogue-ca', { now: NOW });
    const rogueVerifier = new CertificateVerifier({ trustAnchors: [rogueCa.rootCertificate], clock: () => NOW });

    const { serverConn, clientConn, clientTls } = connectPair(server, client, rogueVerifier, issued);

    expect(clientTls.result).toBe('failure');
    expect(clientConn.state).not.toBe('established');
    expect(serverConn.state).not.toBe('established');
  });

  it('exchanges real stream data over the resulting 1-RTT keys', () => {
    const { server, client } = topology();
    const { verifier, issued } = issueServerCert();
    const { serverConn, clientConn } = connectPair(server, client, verifier, issued);

    const received: QuicMessage[] = [];
    serverConn.onMessage((msg) => received.push(msg));

    const streamId = clientConn.openStream('bidirectional');
    clientConn.sendData(streamId, 'hello over real quic+tls', true);

    expect(received).toHaveLength(1);
    expect(new TextDecoder().decode(received[0].data)).toBe('hello over real quic+tls');
  });

  it('data flows in both directions after the handshake', () => {
    const { server, client } = topology();
    const { verifier, issued } = issueServerCert();
    const { serverConn, clientConn } = connectPair(server, client, verifier, issued);

    const clientReceived: QuicMessage[] = [];
    clientConn.onMessage((msg) => clientReceived.push(msg));

    const streamId = clientConn.openStream('bidirectional');
    clientConn.sendData(streamId, 'ping', false);
    serverConn.sendData(streamId, 'pong', true);

    expect(clientReceived).toHaveLength(1);
    expect(new TextDecoder().decode(clientReceived[0].data)).toBe('pong');
  });

  it('a clean shutdown still works after a real handshake', () => {
    const { server, client } = topology();
    const { verifier, issued } = issueServerCert();
    const { serverConn, clientConn } = connectPair(server, client, verifier, issued);

    let serverClosedCode: number | null = null;
    serverConn.onClose((code) => { serverClosedCode = code; });

    clientConn.close(7, 'bye');

    expect(clientConn.state).toBe('closing');
    expect(serverConn.state).toBe('draining');
    expect(serverClosedCode).toBe(7);
  });
});
