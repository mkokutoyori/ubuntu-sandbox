/**
 * PRD-HTTP.md §5 P8 — HTTP/2 (`h2c`, "prior knowledge", RFC 9113) + HPACK
 * (RFC 7541). Frame layer and HPACK are tested standalone (pure encode/
 * decode, no network); Http2Connection is tested over a real wired
 * TcpStack topology, on a dedicated test port. Scope is h2c only — no
 * ALPN/TLS (that's P7, blocked on PRD-TLS.md).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { EndHost } from '@/network/devices/EndHost';
import {
  encodeFrame, decodeFrame, decodeFrames,
  FLAG_END_HEADERS, FLAG_END_STREAM, FLAG_ACK,
  encodeSettingsPayload, decodeSettingsPayload,
  encodeWindowUpdatePayload, decodeWindowUpdatePayload,
  encodeRstStreamPayload, decodeRstStreamPayload,
  encodeGoawayPayload, decodeGoawayPayload,
} from '@/network/http/http2/Http2Frame';
import {
  HpackContext, encodeInteger, decodeInteger, encodeString, decodeString,
  encodeHeaderField, decodeHeaderField, encodeHeaderBlock, decodeHeaderBlock,
  STATIC_TABLE,
} from '@/network/http/http2/Hpack';
import { Http2Connection } from '@/network/http/http2/Http2Connection';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('Http2Frame — binary frame header (RFC 9113 §4)', () => {
  it('round-trips a HEADERS frame', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const bytes = encodeFrame({ type: 'HEADERS', flags: FLAG_END_HEADERS, streamId: 1, payload });
    const decoded = decodeFrame(bytes)!;
    expect(decoded.frame.type).toBe('HEADERS');
    expect(decoded.frame.flags).toBe(FLAG_END_HEADERS);
    expect(decoded.frame.streamId).toBe(1);
    expect(decoded.frame.payload).toEqual(payload);
    expect(decoded.bytesConsumed).toBe(bytes.length);
  });

  it('rejects an unknown frame type', () => {
    const bytes = new Uint8Array([0, 0, 0, 0xff, 0, 0, 0, 0, 0]);
    expect(decodeFrame(bytes)).toBeNull();
  });

  it('returns null on a truncated frame', () => {
    const bytes = encodeFrame({ type: 'DATA', flags: 0, streamId: 3, payload: new Uint8Array([1, 2, 3]) });
    expect(decodeFrame(bytes.slice(0, bytes.length - 1))).toBeNull();
  });

  it('decodeFrames parses multiple concatenated frames and returns leftover bytes', () => {
    const f1 = encodeFrame({ type: 'PING', flags: 0, streamId: 0, payload: new Uint8Array(8) });
    const f2 = encodeFrame({ type: 'SETTINGS', flags: FLAG_ACK, streamId: 0, payload: new Uint8Array(0) });
    const partial = encodeFrame({ type: 'DATA', flags: 0, streamId: 1, payload: new Uint8Array([9, 9]) }).slice(0, 5);
    const combined = new Uint8Array([...f1, ...f2, ...partial]);
    const { frames, rest } = decodeFrames(combined);
    expect(frames.map((f) => f.type)).toEqual(['PING', 'SETTINGS']);
    expect(rest).toEqual(partial);
  });

  it('encodes/decodes SETTINGS payload', () => {
    const payload = encodeSettingsPayload({ initialWindowSize: 65535, maxConcurrentStreams: 100 });
    expect(decodeSettingsPayload(payload)).toEqual({ initialWindowSize: 65535, maxConcurrentStreams: 100 });
  });

  it('encodes/decodes WINDOW_UPDATE payload', () => {
    expect(decodeWindowUpdatePayload(encodeWindowUpdatePayload(12345))).toBe(12345);
  });

  it('encodes/decodes RST_STREAM payload', () => {
    expect(decodeRstStreamPayload(encodeRstStreamPayload(8))).toBe(8);
  });

  it('encodes/decodes GOAWAY payload with debug data', () => {
    const debugData = new TextEncoder().encode('bye');
    const payload = encodeGoawayPayload(7, 0, debugData);
    const decoded = decodeGoawayPayload(payload);
    expect(decoded.lastStreamId).toBe(7);
    expect(decoded.errorCode).toBe(0);
    expect(new TextDecoder().decode(decoded.debugData)).toBe('bye');
  });
});

describe('HPACK — integers and strings (RFC 7541 §5)', () => {
  it('round-trips a small integer fitting in the prefix', () => {
    const bytes = new Uint8Array(encodeInteger(10, 5, 0));
    expect(decodeInteger(bytes, 0, 5)).toEqual({ value: 10, bytesConsumed: 1 });
  });

  it('round-trips a large integer requiring continuation bytes', () => {
    const bytes = new Uint8Array(encodeInteger(1337, 5, 0));
    expect(decodeInteger(bytes, 0, 5).value).toBe(1337);
  });

  it('round-trips a string literal', () => {
    const bytes = new Uint8Array(encodeString('hello world'));
    const decoded = decodeString(bytes, 0)!;
    expect(decoded.value).toBe('hello world');
    expect(decoded.bytesConsumed).toBe(bytes.length);
  });
});

describe('HPACK — header field encode/decode (RFC 7541 §6)', () => {
  it('uses the static table for a well-known exact match (indexed header field)', () => {
    const ctx = new HpackContext();
    const bytes = new Uint8Array(encodeHeaderField(ctx, ':method', 'GET'));
    expect(bytes.length).toBe(1);
    expect(bytes[0] & 0x80).not.toBe(0);
  });

  it('round-trips a header not in the static table (literal with incremental indexing)', () => {
    const encCtx = new HpackContext();
    const decCtx = new HpackContext();
    const bytes = new Uint8Array(encodeHeaderField(encCtx, 'x-custom', 'value1'));
    const decoded = decodeHeaderField(decCtx, bytes, 0)!;
    expect(decoded).toMatchObject({ kind: 'header', name: 'x-custom', value: 'value1' });
    expect(encCtx.dynamicTable.length).toBe(1);
    expect(decCtx.dynamicTable.length).toBe(1);
  });

  it('a second occurrence of the same header is encoded as an indexed field from the dynamic table', () => {
    const ctx = new HpackContext();
    encodeHeaderField(ctx, 'x-custom', 'value1');
    const second = new Uint8Array(encodeHeaderField(ctx, 'x-custom', 'value1'));
    expect(second.length).toBe(1);
    expect(second[0] & 0x80).not.toBe(0);
  });

  it('evicts the oldest dynamic table entry once the size cap is exceeded', () => {
    const ctx = new HpackContext();
    ctx.dynamicTable.setMaxSize(70);
    encodeHeaderField(ctx, 'a', '1'); // ~34 bytes
    encodeHeaderField(ctx, 'b', '2'); // ~34 bytes, total ~68, still fits
    expect(ctx.dynamicTable.length).toBe(2);
    encodeHeaderField(ctx, 'c', '3'); // pushes total over 70 -> evicts 'a'
    expect(ctx.dynamicTable.length).toBeLessThanOrEqual(2);
    expect(ctx.dynamicTable.get(ctx.dynamicTable.length - 1)?.name).not.toBe('a');
  });

  it('a dynamic table size update instruction resizes the table', () => {
    const ctx = new HpackContext();
    const bytes = new Uint8Array(encodeInteger(0, 5, 0x20));
    const decoded = decodeHeaderField(ctx, bytes, 0)!;
    expect(decoded.kind).toBe('sizeUpdate');
  });

  it('round-trips a full header block of several headers, matching the static table\'s known values', () => {
    const encCtx = new HpackContext();
    const decCtx = new HpackContext();
    const headers: [string, string][] = [[':method', 'GET'], [':path', '/'], ['x-request-id', 'abc-123']];
    const bytes = encodeHeaderBlock(encCtx, headers);
    expect(decodeHeaderBlock(decCtx, bytes)).toEqual(headers);
  });

  it('the static table has exactly 61 entries per RFC 7541 Appendix A', () => {
    expect(STATIC_TABLE.length).toBe(61);
    expect(STATIC_TABLE[0]).toEqual({ name: ':authority', value: '' });
    expect(STATIC_TABLE[7]).toEqual({ name: ':status', value: '200' });
    expect(STATIC_TABLE[60]).toEqual({ name: 'www-authenticate', value: '' });
  });
});

const TEST_PORT = 8720;

function topology() {
  const server = new LinuxPC('linux-pc', 'H2SRV');
  const client = new LinuxPC('linux-pc', 'H2CLIENT');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.98.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.98.20'), mask);
  return { server: server as unknown as EndHost, client: client as unknown as EndHost };
}

describe('Http2Connection — h2c prior-knowledge, real TCP wire, dedicated test port', () => {
  it('completes the connection preface + SETTINGS handshake and exchanges a request/response', () => {
    const { server, client } = topology();
    Http2Connection.listen(server.getTcpStack(), TEST_PORT, (headers, body) => {
      const path = headers.find(([k]) => k === ':path')?.[1];
      return { headers: [[':status', '200'], ['content-type', 'text/plain']], body: new TextEncoder().encode(`echo:${path}:${new TextDecoder().decode(body)}`) };
    });

    const conn = Http2Connection.connect(client.getTcpStack(), '192.168.98.10', TEST_PORT)!;
    expect(conn).not.toBeNull();
    const result = conn.request([[':method', 'GET'], [':path', '/hello'], [':scheme', 'http']], new TextEncoder().encode('ping'));

    expect(result).not.toBeNull();
    expect(result!.headers).toContainEqual([':status', '200']);
    expect(new TextDecoder().decode(result!.body)).toBe('echo:/hello:ping');
  });

  it('multiplexes two independent requests over the same connection', () => {
    const { server, client } = topology();
    Http2Connection.listen(server.getTcpStack(), TEST_PORT, (headers) => {
      const path = headers.find(([k]) => k === ':path')?.[1];
      return { headers: [[':status', '200']], body: new TextEncoder().encode(`response-for-${path}`) };
    });

    const conn = Http2Connection.connect(client.getTcpStack(), '192.168.98.10', TEST_PORT)!;
    const r1 = conn.request([[':method', 'GET'], [':path', '/a']]);
    const r2 = conn.request([[':method', 'GET'], [':path', '/b']]);

    expect(new TextDecoder().decode(r1!.body)).toBe('response-for-/a');
    expect(new TextDecoder().decode(r2!.body)).toBe('response-for-/b');
  });

  it('correctly transfers a body larger than the initial flow-control window (real windowed send + auto WINDOW_UPDATE)', () => {
    const { server, client } = topology();
    let receivedLength = 0;
    Http2Connection.listen(server.getTcpStack(), TEST_PORT, (_headers, body) => {
      receivedLength = body.length;
      return { headers: [[':status', '200']], body: new Uint8Array(0) };
    });

    const conn = Http2Connection.connect(client.getTcpStack(), '192.168.98.10', TEST_PORT)!;
    const largeBody = new Uint8Array(100_000).fill(42);
    const result = conn.request([[':method', 'POST'], [':path', '/upload']], largeBody);

    expect(result).not.toBeNull();
    expect(receivedLength).toBe(100_000);
  });

  it('rejects a connection whose preface does not match', () => {
    const { server, client } = topology();
    Http2Connection.listen(server.getTcpStack(), TEST_PORT, () => ({ headers: [], body: new Uint8Array(0) }));

    const socket = client.getTcpStack().connect('192.168.98.10', TEST_PORT)!;
    socket.write('NOT THE HTTP/2 PREFACE AT ALL....');
    expect(socket.closed).toBe(true);
  });
});
