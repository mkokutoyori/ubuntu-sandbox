/**
 * PRD-HTTP.md §5 P6 — WebSocket (RFC 6455): HTTP/1.1 upgrade handshake
 * (Sec-WebSocket-Accept against the RFC's own §1.3 test vector), binary
 * frame encode/decode (masking, extended length), and the event-driven
 * WebSocketConnection (fragmentation, ping/pong, close) over a real wired
 * TCP topology on a dedicated test port.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { EndHost } from '@/network/devices/EndHost';
import { parseRequest, parseResponse, encodeRequest, encodeResponse } from '@/network/http/http1/Http1Wire';
import {
  computeAcceptKey, generateWebSocketKey, buildUpgradeRequest,
  verifyUpgradeRequest, buildUpgradeResponse, verifyUpgradeResponse,
} from '@/network/http/websocket/WebSocketHandshake';
import { encodeFrame, decodeFrame } from '@/network/http/websocket/WebSocketFrame';
import { WebSocketConnection, type WebSocketMessage } from '@/network/http/websocket/WebSocketConnection';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('WebSocketHandshake — Sec-WebSocket-Accept (RFC 6455 §1.3 test vector)', () => {
  it('matches the RFC\'s own published example', () => {
    expect(computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('WebSocketHandshake — request/response build and verify', () => {
  it('generateWebSocketKey produces a base64 encoding of 16 raw bytes', () => {
    const key = generateWebSocketKey();
    const decoded = atob(key);
    expect(decoded.length).toBe(16);
  });

  it('buildUpgradeRequest sets the required headers', () => {
    const req = buildUpgradeRequest('/chat', 'abc123');
    expect(req.headers.get('Upgrade')).toBe('websocket');
    expect(req.headers.get('Connection')).toBe('Upgrade');
    expect(req.headers.get('Sec-WebSocket-Key')).toBe('abc123');
    expect(req.headers.get('Sec-WebSocket-Version')).toBe('13');
  });

  it('verifyUpgradeRequest accepts a well-formed request and returns the key', () => {
    const req = buildUpgradeRequest('/chat', 'abc123');
    const check = verifyUpgradeRequest(req);
    expect(check.ok).toBe(true);
    expect(check.key).toBe('abc123');
  });

  it('verifyUpgradeRequest rejects a request missing Sec-WebSocket-Key', () => {
    const req = buildUpgradeRequest('/chat', 'abc123');
    req.headers.delete('Sec-WebSocket-Key');
    expect(verifyUpgradeRequest(req).ok).toBe(false);
  });

  it('buildUpgradeResponse / verifyUpgradeResponse round-trip', () => {
    const key = generateWebSocketKey();
    const res = buildUpgradeResponse(key);
    expect(res.statusCode).toBe(101);
    expect(verifyUpgradeResponse(res, key)).toBe(true);
    expect(verifyUpgradeResponse(res, 'wrong-key')).toBe(false);
  });
});

describe('WebSocketFrame — encode/decode round-trip (RFC 6455 §5.2)', () => {
  it('round-trips a small unmasked text frame', () => {
    const payload = new TextEncoder().encode('hello');
    const bytes = encodeFrame({ fin: true, opcode: 'text', masked: false, payload });
    const decoded = decodeFrame(bytes)!;
    expect(decoded.frame.fin).toBe(true);
    expect(decoded.frame.opcode).toBe('text');
    expect(decoded.frame.masked).toBe(false);
    expect(new TextDecoder().decode(decoded.frame.payload)).toBe('hello');
    expect(decoded.bytesConsumed).toBe(bytes.length);
  });

  it('round-trips a masked frame, unmasking correctly on decode', () => {
    const payload = new TextEncoder().encode('secret');
    const maskingKey: [number, number, number, number] = [0x12, 0x34, 0x56, 0x78];
    const bytes = encodeFrame({ fin: true, opcode: 'binary', masked: true, maskingKey, payload });
    const decoded = decodeFrame(bytes)!;
    expect(decoded.frame.masked).toBe(true);
    expect(decoded.frame.maskingKey).toEqual(maskingKey);
    expect(new TextDecoder().decode(decoded.frame.payload)).toBe('secret');
  });

  it('round-trips a 16-bit extended length payload (>= 126 bytes)', () => {
    const payload = new Uint8Array(300).fill(65);
    const bytes = encodeFrame({ fin: true, opcode: 'binary', masked: false, payload });
    const decoded = decodeFrame(bytes)!;
    expect(decoded.frame.payload.length).toBe(300);
  });

  it('round-trips a 64-bit extended length payload (> 0xFFFF bytes)', () => {
    const payload = new Uint8Array(70_000).fill(66);
    const bytes = encodeFrame({ fin: true, opcode: 'binary', masked: false, payload });
    const decoded = decodeFrame(bytes)!;
    expect(decoded.frame.payload.length).toBe(70_000);
  });

  it('encodes fin=false for a non-final fragment', () => {
    const bytes = encodeFrame({ fin: false, opcode: 'text', masked: false, payload: new Uint8Array(0) });
    expect(decodeFrame(bytes)!.frame.fin).toBe(false);
  });

  it('returns null for truncated input', () => {
    expect(decodeFrame(new Uint8Array([0x81]))).toBeNull();
    const full = encodeFrame({ fin: true, opcode: 'text', masked: false, payload: new TextEncoder().encode('hello') });
    expect(decodeFrame(full.slice(0, full.length - 2))).toBeNull();
  });

  it('returns null for an unknown opcode', () => {
    expect(decodeFrame(new Uint8Array([0x83, 0x00]))).toBeNull();
  });
});

const TEST_PORT = 8456;

function topology() {
  const server = new LinuxPC('linux-pc', 'WSSRV');
  const client = new LinuxPC('linux-pc', 'WSCLIENT');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.97.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.97.20'), mask);
  return { server: server as unknown as EndHost, client: client as unknown as EndHost };
}

function connectWebSocket(serverHost: EndHost, clientHost: EndHost, onServerConnection: (ws: WebSocketConnection) => void) {
  serverHost.getTcpStack().listen(TEST_PORT, {
    onAccept: (socket) => {
      const unsub = socket.onData((data) => {
        const parsed = parseRequest(String(data));
        if (!parsed.ok) return;
        const check = verifyUpgradeRequest(parsed.message);
        if (!check.ok) return;
        socket.write(encodeResponse(buildUpgradeResponse(check.key!)));
        unsub();
        onServerConnection(new WebSocketConnection(socket, 'server'));
      });
    },
  });

  const socket = clientHost.getTcpStack().connect('192.168.97.10', TEST_PORT)!;
  const key = generateWebSocketKey();
  let responseText = '';
  const unsub = socket.onData((data) => { responseText = String(data); });
  socket.write(encodeRequest(buildUpgradeRequest('/ws', key)));
  unsub();

  const parsedResponse = parseResponse(responseText, { suppressBody: true });
  if (!parsedResponse.ok || !verifyUpgradeResponse(parsedResponse.message, key)) {
    throw new Error('WebSocket upgrade handshake failed in test harness');
  }
  return new WebSocketConnection(socket, 'client');
}

describe('WebSocketConnection — real TCP wire, dedicated test port', () => {
  it('completes the HTTP/1.1 upgrade handshake and exchanges a text message', () => {
    const { server, client } = topology();
    let received: WebSocketMessage | null = null;
    const clientWs = connectWebSocket(server, client, (serverWs) => {
      serverWs.onMessage((msg) => serverWs.send(new TextDecoder().decode(msg.payload).toUpperCase()));
    });
    clientWs.onMessage((msg) => { received = msg; });

    clientWs.send('hello');
    expect(received).not.toBeNull();
    expect(received!.opcode).toBe('text');
    expect(new TextDecoder().decode(received!.payload)).toBe('HELLO');
  });

  it('reassembles a fragmented message sent via continuation frames', () => {
    const { server, client } = topology();
    let received: WebSocketMessage | null = null;
    const clientWs = connectWebSocket(server, client, (serverWs) => {
      serverWs.onMessage((msg) => { received = msg; });
    });

    clientWs.sendFragmented(['Hello, ', 'World', '!']);
    expect(received).not.toBeNull();
    expect(new TextDecoder().decode(received!.payload)).toBe('Hello, World!');
  });

  it('replies to a ping with a pong automatically', () => {
    const { server, client } = topology();
    let gotPong = false;
    const clientWs = connectWebSocket(server, client, () => {});
    clientWs.onPong(() => { gotPong = true; });
    clientWs.ping(new TextEncoder().encode('ping-payload'));
    expect(gotPong).toBe(true);
  });

  it('a close frame is answered with close and fires onClose with the status code', () => {
    const { server, client } = topology();
    let serverClosedCode: number | null = null;
    const clientWs = connectWebSocket(server, client, (serverWs) => {
      serverWs.onClose((code) => { serverClosedCode = code; });
    });
    let clientClosedCode: number | null = null;
    clientWs.onClose((code) => { clientClosedCode = code; });

    clientWs.close(1000, 'bye');
    expect(clientClosedCode).toBe(1000);
    expect(serverClosedCode).toBe(1000);
  });
});
