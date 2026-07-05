/**
 * PRD-HTTP.md §5 P2 — HTTP/1.1 real text framing (RFC 9112): request-line/
 * header-fields/CRLF, chunked transfer-encoding with trailers, persistent
 * connections by default, and rejection of a Content-Length/
 * Transfer-Encoding inconsistency. `Http1Wire` is tested standalone
 * (pure encode/decode, no network); `Http1ClientSession`/`Http1ServerSession`
 * are tested over a real wired TCP topology on a dedicated test port
 * (never 80/443, so as not to interfere with the IIS/curl suites).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { EndHost } from '@/network/devices/EndHost';
import { createRequest, createResponse, OrderedMultimap } from '@/network/http/semantics/types';
import {
  encodeRequest,
  encodeResponse,
  parseRequest,
  parseResponse,
  encodeChunkedBody,
  decodeChunkedBody,
} from '@/network/http/http1/Http1Wire';
import { Http1ClientSession } from '@/network/http/http1/Http1ClientSession';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('Http1Wire — encode/decode round-trip (no network)', () => {
  it('round-trips a GET request with headers and no body', () => {
    const req = createRequest('GET', '/index.html');
    req.headers.append('Host', 'example.local');
    const raw = encodeRequest(req);
    expect(raw).toContain('GET /index.html HTTP/1.1\r\n');
    expect(raw).toContain('Host: example.local\r\n');
    expect(raw).toContain('Content-Length: 0');

    const parsed = parseRequest(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.message.method).toBe('GET');
      expect(parsed.message.target).toBe('/index.html');
      expect(parsed.message.headers.get('Host')).toBe('example.local');
      expect(parsed.message.body).toBeNull();
    }
  });

  it('round-trips a POST request with a body, auto-computing Content-Length', () => {
    const req = createRequest('POST', '/submit');
    req.body = new TextEncoder().encode('name=arthur');
    const raw = encodeRequest(req);
    expect(raw).toContain('Content-Length: 11');
    expect(raw.endsWith('name=arthur')).toBe(true);

    const parsed = parseRequest(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(new TextDecoder().decode(parsed.message.body!)).toBe('name=arthur');
  });

  it('round-trips a 200 response with a body', () => {
    const res = createResponse(200, 'OK');
    res.headers.append('Content-Type', 'text/html');
    res.body = new TextEncoder().encode('<html>hi</html>');
    const raw = encodeResponse(res);
    expect(raw).toContain('HTTP/1.1 200 OK\r\n');

    const parsed = parseResponse(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.message.statusCode).toBe(200);
      expect(new TextDecoder().decode(parsed.message.body!)).toBe('<html>hi</html>');
    }
  });

  it('suppresses the body for a HEAD response regardless of headers', () => {
    const res = createResponse(200, 'OK');
    res.headers.set('Content-Length', '5');
    const raw = 'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello';
    const parsed = parseResponse(raw, { suppressBody: true });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.message.body).toBeNull();
  });

  it('a malformed request-line is rejected as 400', () => {
    const parsed = parseRequest('NOT A REQUEST\r\nHost: x\r\n\r\n');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.status).toBe(400);
  });

  it('round-trips an arbitrary binary body byte-for-byte, not just valid UTF-8 text', () => {
    // Bytes deliberately including values that are not valid standalone
    // UTF-8 (e.g. 0xC0, 0xFF): a real TextEncoder/TextDecoder round-trip
    // would corrupt these (replaced with U+FFFD), which matters for any
    // non-text media type (e.g. application/dns-message).
    const original = new Uint8Array([0xc0, 0x00, 0x02, 0x0a, 0xff, 0x80, 0x81, 0x00, 0x41, 0x42]);
    const req = createRequest('POST', '/binary');
    req.headers.append('Content-Type', 'application/octet-stream');
    req.body = original;
    const raw = encodeRequest(req);

    const parsed = parseRequest(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.message.body).toEqual(original);
  });
});

describe('Http1Wire — chunked transfer-encoding (RFC 9112 §7.1)', () => {
  it('round-trips a chunked body with trailers', () => {
    const trailers = new OrderedMultimap<string>();
    trailers.append('X-Checksum', 'abc123');
    const encoded = encodeChunkedBody(['hello ', 'world'], trailers);
    const decoded = decodeChunkedBody(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.body).toBe('hello world');
    expect(decoded!.trailers.get('X-Checksum')).toBe('abc123');
  });

  it('encodes a request with chunked transfer-encoding end to end', () => {
    const req = createRequest('POST', '/upload');
    req.body = new TextEncoder().encode('payload-data');
    const raw = encodeRequest(req, { chunked: true });
    expect(raw).toContain('Transfer-Encoding: chunked');
    expect(raw).not.toContain('Content-Length');

    const parsed = parseRequest(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(new TextDecoder().decode(parsed.message.body!)).toBe('payload-data');
  });

  it('rejects a malformed chunked body', () => {
    expect(decodeChunkedBody('not-a-valid-chunk-stream')).toBeNull();
  });
});

describe('Http1Wire — Content-Length/Transfer-Encoding inconsistency (RFC 9112 §6.3)', () => {
  it('rejects a request carrying both headers', () => {
    const raw = 'POST /x HTTP/1.1\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n';
    const parsed = parseRequest(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.status).toBe(400);
  });

  it('rejects a response carrying both headers', () => {
    const raw = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\nhi';
    const parsed = parseResponse(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.status).toBe(400);
  });
});

const TEST_PORT = 8123;

function topology() {
  const server = new LinuxPC('linux-pc', 'HTTP1SRV');
  const client = new LinuxPC('linux-pc', 'HTTP1CLIENT');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.96.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.96.20'), mask);
  return { server: server as unknown as EndHost, client: client as unknown as EndHost };
}

describe('Http1ClientSession / Http1ServerSession — real TCP wire, dedicated test port', () => {
  it('a single request/response round-trips over the wire', () => {
    const { server, client } = topology();
    const srv = new Http1ServerSession(server.getTcpStack(), TEST_PORT, (req) => {
      const res = createResponse(200, 'OK');
      res.headers.append('Content-Type', 'text/plain');
      res.body = new TextEncoder().encode(`echo:${req.target}`);
      return res;
    });
    srv.start();

    const client1 = new Http1ClientSession(client.getTcpStack(), '192.168.96.10', TEST_PORT);
    const result = client1.send(createRequest('GET', '/hello'));
    expect(result.ok).toBe(true);
    expect(result.response!.statusCode).toBe(200);
    expect(new TextDecoder().decode(result.response!.body!)).toBe('echo:/hello');
  });

  it('reuses the same persistent connection across multiple requests', () => {
    const { server, client } = topology();
    const srv = new Http1ServerSession(server.getTcpStack(), TEST_PORT, (req) => {
      const res = createResponse(200, 'OK');
      res.body = new TextEncoder().encode(req.target ?? '');
      return res;
    });
    srv.start();

    const session = new Http1ClientSession(client.getTcpStack(), '192.168.96.10', TEST_PORT);
    const r1 = session.send(createRequest('GET', '/one'));
    const socketAfterFirst = (session as unknown as { socket: { localPort: number } }).socket;
    const r2 = session.send(createRequest('GET', '/two'));
    const socketAfterSecond = (session as unknown as { socket: { localPort: number } }).socket;

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(new TextDecoder().decode(r1.response!.body!)).toBe('/one');
    expect(new TextDecoder().decode(r2.response!.body!)).toBe('/two');
    expect(socketAfterFirst).toBe(socketAfterSecond);
    expect(socketAfterFirst?.localPort).toBeDefined();
  });

  it('Connection: close from the server ends the connection, next send reconnects', () => {
    const { server, client } = topology();
    const srv = new Http1ServerSession(server.getTcpStack(), TEST_PORT, (req) => {
      const res = createResponse(200, 'OK');
      res.body = new TextEncoder().encode(req.target ?? '');
      if (req.target === '/bye') res.headers.set('Connection', 'close');
      return res;
    });
    srv.start();

    const session = new Http1ClientSession(client.getTcpStack(), '192.168.96.10', TEST_PORT);
    session.send(createRequest('GET', '/bye'));
    const socketAfterClose = (session as unknown as { socket: unknown }).socket;
    expect(socketAfterClose).toBeNull();

    const r2 = session.send(createRequest('GET', '/again'));
    expect(r2.ok).toBe(true);
    expect(new TextDecoder().decode(r2.response!.body!)).toBe('/again');
  });

  it('a chunked response is received correctly by the client', () => {
    const { server, client } = topology();
    const srv = new Http1ServerSession(server.getTcpStack(), TEST_PORT, () => {
      const res = createResponse(200, 'OK');
      res.headers.set('Transfer-Encoding', 'chunked');
      res.body = new TextEncoder().encode('chunked-body-content');
      return res;
    });
    srv.start();

    const client1 = new Http1ClientSession(client.getTcpStack(), '192.168.96.10', TEST_PORT);
    const result = client1.send(createRequest('GET', '/chunked'));
    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(result.response!.body!)).toBe('chunked-body-content');
  });

  it('connecting to a server with no listener reports connection refused', () => {
    const { client } = topology();
    const session = new Http1ClientSession(client.getTcpStack(), '192.168.96.10', TEST_PORT);
    const result = session.send(createRequest('GET', '/'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refused/i);
  });
});
