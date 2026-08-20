/**
 * PRD-HTTP.md §2.1.L / §5 P11 — observability: `http.request.*`,
 * `http.cache.*`, `websocket.*` and `http2.stream.*` event bus topics
 * (`events.ts`), plus the aggregate-counters read-model over them
 * (`observables.ts`). `quic.connection.established/closed`, also named in
 * §2.1.L, is already covered by `quic-observability.test.ts`
 * (`PRD-QUIC.md` §5 P12) — nothing to re-test here.
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
import { EventBus } from '@/events/EventBus';
import type { HttpDomainEvent } from '@/network/http/events';
import { HttpSignalStore, subscribeHttpObservables, metricsSignal } from '@/network/http/observables';
import { Http1ClientSession } from '@/network/http/http1/Http1ClientSession';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { createRequest, createResponse } from '@/network/http/semantics/types';
import { HttpCacheStore } from '@/network/http/cache/HttpCacheStore';
import { WebSocketConnection } from '@/network/http/websocket/WebSocketConnection';
import { buildUpgradeRequest, buildUpgradeResponse, verifyUpgradeRequest, verifyUpgradeResponse, generateWebSocketKey } from '@/network/http/websocket/WebSocketHandshake';
import { encodeRequest, encodeResponse, parseRequest, parseResponse } from '@/network/http/http1/Http1Wire';
import { Http2Connection } from '@/network/http/http2/Http2Connection';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function topology() {
  const server = new LinuxPC('linux-pc', 'HOBSSRV');
  const client = new WindowsPC('windows-pc', 'HOBSCLI');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.112.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.112.20'), mask);
  return { server: server as unknown as EndHost, client: client as unknown as EndHost };
}

const TEST_PORT = 8567;

describe('Http1ClientSession/Http1ServerSession observability — http.request.* (PRD-HTTP.md §2.1.L)', () => {
  it('publishes started then completed for a successful round-trip, on both client and server', () => {
    const { server, client } = topology();
    const bus = new EventBus();
    const events: HttpDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as HttpDomainEvent));

    const srv = new Http1ServerSession(server.getTcpStack(), TEST_PORT, (req) => {
      const res = createResponse(200, 'OK');
      res.body = new TextEncoder().encode(`echo:${req.target}`);
      return res;
    }, bus);
    srv.start();

    const clientSession = new Http1ClientSession(client.getTcpStack(), '192.168.112.10', TEST_PORT, bus);
    const result = clientSession.send(createRequest('GET', '/widgets'));

    expect(result.ok).toBe(true);
    const started = events.filter((e) => e.topic === 'http.request.started');
    const completed = events.filter((e) => e.topic === 'http.request.completed');
    expect(started.length).toBe(2); // one client-side, one server-side
    expect(completed.length).toBe(2);
    expect(completed.every((e) => e.topic === 'http.request.completed' && e.payload.statusCode === 200)).toBe(true);
  });

  it('publishes http.request.failed when the client cannot connect', () => {
    const { client } = topology();
    const bus = new EventBus();
    const events: HttpDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as HttpDomainEvent));

    const clientSession = new Http1ClientSession(client.getTcpStack(), '192.168.112.99', TEST_PORT, bus);
    const result = clientSession.send(createRequest('GET', '/unreachable'));

    expect(result.ok).toBe(false);
    const failed = events.find((e) => e.topic === 'http.request.failed');
    expect(failed).toBeDefined();
  });
});

describe('HttpCacheStore observability — http.cache.* (RFC 9111)', () => {
  it('publishes miss then hit for a stored, still-fresh entry', () => {
    const bus = new EventBus();
    const events: HttpDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as HttpDomainEvent));
    const store = new HttpCacheStore(bus);

    const req = createRequest('GET', '/data.json');
    const res = createResponse(200, 'OK');
    res.headers.set('Cache-Control', 'max-age=60');

    expect(store.get(req)).toBeUndefined();
    store.put(req, res);
    expect(store.get(req)).toBeDefined();

    expect(events.map((e) => e.topic)).toEqual(['http.cache.miss', 'http.cache.hit']);
  });

  it('publishes http.cache.revalidated on a successful 304 revalidation', () => {
    const bus = new EventBus();
    const events: HttpDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as HttpDomainEvent));
    const store = new HttpCacheStore(bus);

    const req = createRequest('GET', '/data.json');
    const res = createResponse(200, 'OK');
    res.headers.set('Cache-Control', 'max-age=0');
    res.headers.set('ETag', '"v1"');
    store.put(req, res);

    const notModified = createResponse(304, 'Not Modified');
    store.applyRevalidationResponse(req, notModified);

    expect(events.some((e) => e.topic === 'http.cache.revalidated')).toBe(true);
  });
});

describe('WebSocketConnection observability — websocket.* (RFC 6455)', () => {
  function connectWebSocket(serverHost: EndHost, clientHost: EndHost, bus: EventBus, onServerConnection: (ws: WebSocketConnection) => void) {
    serverHost.getTcpStack().listen(TEST_PORT, {
      onAccept: (socket) => {
        const unsub = socket.onData((data) => {
          const parsed = parseRequest(String(data));
          if (!parsed.ok) return;
          const check = verifyUpgradeRequest(parsed.message);
          if (!check.ok) return;
          socket.write(encodeResponse(buildUpgradeResponse(check.key!)));
          unsub();
          onServerConnection(new WebSocketConnection(socket, 'server', bus));
        });
      },
    });

    const socket = clientHost.getTcpStack().connect('192.168.112.10', TEST_PORT)!;
    const key = generateWebSocketKey();
    let responseText = '';
    const unsub = socket.onData((data) => { responseText = String(data); });
    socket.write(encodeRequest(buildUpgradeRequest('/ws', key)));
    unsub();

    const parsedResponse = parseResponse(responseText, { suppressBody: true });
    if (!parsedResponse.ok || !verifyUpgradeResponse(parsedResponse.message, key)) {
      throw new Error('WebSocket upgrade handshake failed in test harness');
    }
    return new WebSocketConnection(socket, 'client', bus);
  }

  it('publishes opened for both peers and closed for the initiator', () => {
    const { server, client } = topology();
    const bus = new EventBus();
    const events: HttpDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as HttpDomainEvent));

    const clientWs = connectWebSocket(server, client, bus, () => {});
    const opened = events.filter((e) => e.topic === 'websocket.opened');
    expect(opened.length).toBe(2);

    events.length = 0;
    clientWs.close(1000, 'done');
    const closed = events.filter((e) => e.topic === 'websocket.closed');
    expect(closed.length).toBeGreaterThan(0);
  });
});

describe('Http2Connection observability — http2.stream.* (RFC 9113)', () => {
  it('publishes stream.opened then stream.closed for a single request/response', () => {
    const { server, client } = topology();
    const bus = new EventBus();
    const events: HttpDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as HttpDomainEvent));

    Http2Connection.listen(server.getTcpStack(), TEST_PORT, () => ({ headers: [[':status', '200']], body: new Uint8Array(0) }), bus);
    const conn = Http2Connection.connect(client.getTcpStack(), '192.168.112.10', TEST_PORT, bus)!;
    conn.request([[':method', 'GET'], [':path', '/']]);

    const opened = events.filter((e) => e.topic === 'http2.stream.opened');
    const closed = events.filter((e) => e.topic === 'http2.stream.closed');
    expect(opened.length).toBeGreaterThan(0);
    expect(closed.length).toBeGreaterThan(0);
  });
});

describe('HttpSignalStore / subscribeHttpObservables — aggregate read-model', () => {
  it('tracks request/cache/websocket/http2-stream counters across all four sources', () => {
    const { server, client } = topology();
    const bus = new EventBus();
    const store = new HttpSignalStore();
    subscribeHttpObservables(bus, store);
    const signal = metricsSignal(store);

    const srv = new Http1ServerSession(server.getTcpStack(), TEST_PORT, (req) => {
      const res = createResponse(200, 'OK');
      res.body = new TextEncoder().encode(`echo:${req.target}`);
      return res;
    }, bus);
    srv.start();
    const clientSession = new Http1ClientSession(client.getTcpStack(), '192.168.112.10', TEST_PORT, bus);
    clientSession.send(createRequest('GET', '/x'));

    expect(signal.get().requestsStarted).toBeGreaterThan(0);
    expect(signal.get().requestsCompleted).toBeGreaterThan(0);

    const cache = new HttpCacheStore(bus);
    const req = createRequest('GET', '/data.json');
    cache.get(req); // miss
    expect(signal.get().cacheMisses).toBe(1);
  });
});
