/**
 * PRD-HTTP.md §5 P10 — HTTP/3 (RFC 9114) + QPACK (RFC 9204, static table
 * only, cf. §2.2). Frame layer and QPACK are tested standalone (pure
 * encode/decode, no network); `Http3Connection` is tested over a real
 * QUIC/TLS connection (`QuicConnection`, mode `tls`, delivered by
 * `PRD-QUIC.md`) on a dedicated test port, mirroring how `http2.test.ts`
 * tests `Http2Connection` over a real wired `TcpStack`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { EndHost } from '@/network/devices/EndHost';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { QuicConnection } from '@/network/quic/QuicConnection';
import {
  encodeFrame, decodeFrames,
  encodeSettingsPayload, decodeSettingsPayload,
  encodeGoawayPayload, decodeGoawayPayload,
  CONTROL_STREAM_TYPE,
} from '@/network/http/http3/Http3Frame';
import { encodeFieldSection, decodeFieldSection, STATIC_TABLE } from '@/network/http/http3/Qpack';
import { Http3Connection } from '@/network/http/http3/Http3Connection';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('Http3Frame — generic Type/Length/Payload layout (RFC 9114 §7.1/§7.2)', () => {
  it('round-trips a HEADERS frame', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const bytes = encodeFrame({ type: 'HEADERS', payload });
    const { frames, rest } = decodeFrames(bytes);
    expect(frames).toEqual([{ type: 'HEADERS', payload }]);
    expect(rest.length).toBe(0);
  });

  it('parses multiple concatenated frames and returns leftover partial bytes', () => {
    const f1 = encodeFrame({ type: 'SETTINGS', payload: new Uint8Array(0) });
    const f2 = encodeFrame({ type: 'DATA', payload: new Uint8Array([9, 9, 9]) });
    const partial = encodeFrame({ type: 'DATA', payload: new Uint8Array([1, 2, 3]) }).slice(0, 2);
    const combined = new Uint8Array([...f1, ...f2, ...partial]);

    const { frames, rest } = decodeFrames(combined);
    expect(frames.map((f) => f.type)).toEqual(['SETTINGS', 'DATA']);
    expect(rest).toEqual(partial);
  });

  it('surfaces an unrecognized frame type as UNKNOWN rather than rejecting it (RFC 9114 §7.2.8)', () => {
    const bytes = encodeFrame({ type: 'DATA', payload: new Uint8Array(0) });
    bytes[0] = 0x0b; // an unassigned frame type code
    const { frames } = decodeFrames(bytes);
    expect(frames).toEqual([{ type: 'UNKNOWN', rawType: 0x0b, payload: new Uint8Array(0) }]);
  });

  it('encodes/decodes a SETTINGS payload', () => {
    const payload = encodeSettingsPayload({ qpackMaxTableCapacity: 0, maxFieldSectionSize: 4096, qpackBlockedStreams: 0 });
    expect(decodeSettingsPayload(payload)).toEqual({ qpackMaxTableCapacity: 0, maxFieldSectionSize: 4096, qpackBlockedStreams: 0 });
  });

  it('encodes/decodes a GOAWAY payload', () => {
    expect(decodeGoawayPayload(encodeGoawayPayload(4))).toBe(4);
  });
});

describe('Qpack — static table only (RFC 9204 §4.5, Appendix A)', () => {
  it('encodes an exact static-table match as an indexed field line', () => {
    const bytes = encodeFieldSection([[':method', 'GET']]);
    expect(decodeFieldSection(bytes)).toEqual([[':method', 'GET']]);
  });

  it('encodes a static-table name match with a different value as a literal with name reference', () => {
    const bytes = encodeFieldSection([[':path', '/index.html']]);
    expect(decodeFieldSection(bytes)).toEqual([[':path', '/index.html']]);
  });

  it('encodes a header absent from the static table as a literal with literal name', () => {
    const bytes = encodeFieldSection([['x-custom-header', 'custom-value']]);
    expect(decodeFieldSection(bytes)).toEqual([['x-custom-header', 'custom-value']]);
  });

  it('round-trips a full field section mixing all three representations', () => {
    const headers: [string, string][] = [
      [':method', 'POST'],
      [':path', '/api/widgets'],
      [':scheme', 'https'],
      ['content-type', 'application/json'],
      ['x-request-id', 'abc-123'],
    ];
    expect(decodeFieldSection(encodeFieldSection(headers))).toEqual(headers);
  });

  it('has at least the well-known RFC 9204 Appendix A pseudo-header entries', () => {
    expect(STATIC_TABLE.find((e) => e.name === ':method' && e.value === 'GET')).toBeDefined();
    expect(STATIC_TABLE.find((e) => e.name === ':status' && e.value === '200')).toBeDefined();
  });
});

const TEST_PORT = 9843;

// Cross-OS topology: a Linux server and a Windows client, exercising the
// same TLS/QUIC/HTTP-3 stack against two independent EndHost implementations.
function topology() {
  const server = new LinuxPC('linux-pc', 'H3SRV');
  const client = new WindowsPC('windows-pc', 'H3CLI');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.111.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.111.20'), mask);
  return { server: server as unknown as EndHost, client: client as unknown as EndHost };
}

function connectPair(server: EndHost, client: EndHost) {
  const NOW = Date.now();
  const ca = CertificateAuthority.generate('CN=http3-test-ca', { now: NOW });
  const issued = ca.issueCertificate({ subject: 'CN=h3.example.test', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

  const serverTls = new TlsServerSession({ serverCert: issued.cert, serverPrivateKey: issued.privateKey, alpnProtocols: ['h3'] });
  const clientTls = new TlsClientSession({ verifier, alpn: ['h3'] });
  const serverConn = new QuicConnection(server, 'server', TEST_PORT, {
    mode: 'tls', tls: serverTls, clientDestConnectionId: 'h3-conn-fixed-dcid',
  });
  const clientConn = new QuicConnection(client, 'client', TEST_PORT, {
    mode: 'tls', tls: clientTls, clientDestConnectionId: 'h3-conn-fixed-dcid',
  });
  clientConn.connect('192.168.111.10', TEST_PORT);
  return { serverConn, clientConn };
}

describe('Http3Connection — request/response mapped onto real QUIC streams (RFC 9114 §4.1)', () => {
  it('completes a GET request/response with headers and a body', () => {
    const { server, client } = topology();
    const { serverConn, clientConn } = connectPair(server, client);

    new Http3Connection(serverConn, 'server', (headers) => {
      expect(headers).toEqual(expect.arrayContaining([[':method', 'GET'], [':path', '/widgets']]));
      return { headers: [[':status', '200'], ['content-type', 'application/json']], body: new TextEncoder().encode('{"ok":true}') };
    });
    const clientH3 = new Http3Connection(clientConn, 'client');

    const result = clientH3.request([[':method', 'GET'], [':path', '/widgets'], [':scheme', 'https'], [':authority', 'h3.example.test']]);

    expect(result).not.toBeNull();
    expect(result!.headers).toContainEqual([':status', '200']);
    expect(new TextDecoder().decode(result!.body)).toBe('{"ok":true}');
  });

  it('multiplexes two independent requests over separate streams', () => {
    const { server, client } = topology();
    const { serverConn, clientConn } = connectPair(server, client);

    new Http3Connection(serverConn, 'server', (headers) => {
      const path = headers.find(([n]) => n === ':path')![1];
      return { headers: [[':status', '200']], body: new TextEncoder().encode(`body-for-${path}`) };
    });
    const clientH3 = new Http3Connection(clientConn, 'client');

    const r1 = clientH3.request([[':method', 'GET'], [':path', '/one']]);
    const r2 = clientH3.request([[':method', 'GET'], [':path', '/two']]);

    expect(new TextDecoder().decode(r1!.body)).toBe('body-for-/one');
    expect(new TextDecoder().decode(r2!.body)).toBe('body-for-/two');
  });

  it('exchanges SETTINGS on unidirectional control streams at connection start', () => {
    const { server, client } = topology();
    const { serverConn, clientConn } = connectPair(server, client);

    const received: { streamId: number; data: Uint8Array }[] = [];
    serverConn.onMessage((msg) => received.push(msg));

    new Http3Connection(clientConn, 'client');

    const controlMessages = received.filter((m) => m.data.length > 0);
    expect(controlMessages.length).toBeGreaterThan(0);
    // First byte of a fresh unidirectional stream is the stream type varint (0x00 = control, RFC 9114 §6.2.1).
    expect(controlMessages[0].data[0]).toBe(CONTROL_STREAM_TYPE);
  });

  it('handles a request with no body (headers-only, fin on the HEADERS send)', () => {
    const { server, client } = topology();
    const { serverConn, clientConn } = connectPair(server, client);

    new Http3Connection(serverConn, 'server', () => ({ headers: [[':status', '204']], body: new Uint8Array(0) }));
    const clientH3 = new Http3Connection(clientConn, 'client');

    const result = clientH3.request([[':method', 'DELETE'], [':path', '/widgets/1']]);
    expect(result!.headers).toContainEqual([':status', '204']);
    expect(result!.body.length).toBe(0);
  });
});
