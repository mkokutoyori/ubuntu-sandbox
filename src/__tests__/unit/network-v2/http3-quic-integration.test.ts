/**
 * PRD-HTTP.md §5 P9 — QUIC integration for HTTP/3. Per the PRD: "no new
 * transport code — verify that `src/network/quic/` (delivered by
 * PRD-QUIC.md) exposes the API expected by `http3/Http3Connection.ts`
 * (bidirectional/unidirectional streams, `send`/`onData`/`close`); write
 * integration tests on the HTTP side against this API". This file
 * exercises `QuicConnection`'s public API (real TLS mode, P8) the way
 * HTTP/3 (P10) will need to use it — no file under `src/network/quic/`
 * is touched, `QuicConnection` is owned entirely by `PRD-QUIC.md`.
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
import { classifyStreamId } from '@/network/quic/QuicStream';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

const NOW = Date.now();
const CLIENT_DEST_CONNECTION_ID = 'h3-fixed-dcid';
const PORT = 9843;

function topology() {
  const server = new LinuxPC('linux-pc', 'H3QSRV');
  const client = new LinuxPC('linux-pc', 'H3QCLIENT');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.110.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.110.20'), mask);
  return { server: server as unknown as EndHost, client: client as unknown as EndHost };
}

function issueServerCert() {
  const ca = CertificateAuthority.generate('CN=http3-quic-test-ca', { now: NOW });
  const issued = ca.issueCertificate({ subject: 'CN=h3.example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
  return { issued, verifier };
}

function connectPair(server: EndHost, client: EndHost, verifier: CertificateVerifier, issued: ReturnType<typeof issueServerCert>['issued']) {
  const serverTls = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey, alpnProtocols: ['h3'] });
  const clientTls = new TlsClientSession({ verifier, alpn: ['h3'] });
  const serverConn = new QuicConnection(server, 'server', PORT, {
    mode: 'tls', tls: serverTls, clientDestConnectionId: CLIENT_DEST_CONNECTION_ID,
  });
  const clientConn = new QuicConnection(client, 'client', PORT, {
    mode: 'tls', tls: clientTls, clientDestConnectionId: CLIENT_DEST_CONNECTION_ID,
  });
  clientConn.connect('192.168.110.10', PORT);
  return { serverConn, clientConn, serverTls, clientTls };
}

describe('HTTP/3 over QUIC — API contract check (PRD-HTTP.md §5 P9)', () => {
  it('negotiates ALPN h3 over a real QUIC/TLS handshake', () => {
    const { server, client } = topology();
    const { verifier, issued } = issueServerCert();
    const { serverConn, clientConn, serverTls, clientTls } = connectPair(server, client, verifier, issued);

    expect(clientConn.state).toBe('established');
    expect(serverConn.state).toBe('established');
    expect(clientTls.negotiatedAlpnProtocol).toBe('h3');
    expect(serverTls.negotiatedAlpnProtocol).toBe('h3');
  });

  it('supports a client-initiated unidirectional stream, the shape HTTP/3 control/QPACK streams need', () => {
    const { server, client } = topology();
    const { verifier, issued } = issueServerCert();
    const { serverConn, clientConn } = connectPair(server, client, verifier, issued);

    const received: QuicMessage[] = [];
    serverConn.onMessage((msg) => received.push(msg));

    const streamId = clientConn.openStream('unidirectional');
    const { initiatedBy, direction } = classifyStreamId(streamId);
    expect(initiatedBy).toBe('client');
    expect(direction).toBe('unidirectional');

    // RFC 9114 §3.2 — a control stream is never closed for the life of the connection;
    // HTTP/3 SETTINGS frames arrive without a FIN.
    clientConn.sendData(streamId, new Uint8Array([0x04, 0x00]), false); // stream type 0x00 (control) + empty SETTINGS

    expect(received).toHaveLength(1);
    expect(received[0].streamId).toBe(streamId);
    expect(received[0].fin).toBe(false);
  });

  it('supports several concurrent client-initiated bidirectional streams, the shape multiplexed HTTP/3 requests need', () => {
    const { server, client } = topology();
    const { verifier, issued } = issueServerCert();
    const { serverConn, clientConn } = connectPair(server, client, verifier, issued);

    const received: QuicMessage[] = [];
    serverConn.onMessage((msg) => received.push(msg));

    const request1 = clientConn.openStream('bidirectional');
    const request2 = clientConn.openStream('bidirectional');
    expect(request2).not.toBe(request1);

    clientConn.sendData(request1, new TextEncoder().encode('request-one-headers-frame'), true);
    clientConn.sendData(request2, new TextEncoder().encode('request-two-headers-frame'), true);

    expect(received).toHaveLength(2);
    const byStream = new Map(received.map((m) => [m.streamId, new TextDecoder().decode(m.data)]));
    expect(byStream.get(request1)).toBe('request-one-headers-frame');
    expect(byStream.get(request2)).toBe('request-two-headers-frame');

    // The server can reply on the same bidirectional stream (request/response), independently per stream.
    const clientReceived: QuicMessage[] = [];
    clientConn.onMessage((msg) => clientReceived.push(msg));
    serverConn.sendData(request1, new TextEncoder().encode('response-one'), true);
    serverConn.sendData(request2, new TextEncoder().encode('response-two'), true);

    expect(clientReceived).toHaveLength(2);
    const responses = new Map(clientReceived.map((m) => [m.streamId, new TextDecoder().decode(m.data)]));
    expect(responses.get(request1)).toBe('response-one');
    expect(responses.get(request2)).toBe('response-two');
  });

  it('supports clean connection close/onClose, needed for GOAWAY-style HTTP/3 shutdown', () => {
    const { server, client } = topology();
    const { verifier, issued } = issueServerCert();
    const { serverConn, clientConn } = connectPair(server, client, verifier, issued);

    let serverClosedCode: number | null = null;
    serverConn.onClose((code) => { serverClosedCode = code; });

    clientConn.close(0, 'h3 graceful shutdown');

    expect(clientConn.state).toBe('closing');
    expect(serverConn.state).toBe('draining');
    expect(serverClosedCode).toBe(0);
  });
});
