/**
 * PRD-QUIC.md §5 P12 — observability (§2.1.11): `quic.*` event bus topics
 * for connection lifecycle, per-packet send/receive/loss, congestion
 * window changes, and stream lifecycle, plus the `observables.ts`
 * read-model over them — same pattern as `tls-observability.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { EndHost } from '@/network/devices/EndHost';
import { EventBus } from '@/events/EventBus';
import { QuicConnection } from '@/network/quic/QuicConnection';
import type { PacketProtectionKeys } from '@/network/quic/types';
import type { QuicDomainEvent } from '@/network/quic/events';
import { QuicSignalStore, subscribeQuicObservables, connectionSignal } from '@/network/quic/observables';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function topology() {
  const server = new LinuxPC('linux-pc', 'QOBSSRV');
  const client = new LinuxPC('linux-pc', 'QOBSCLIENT');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.100.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.100.20'), mask);
  return { server: server as unknown as EndHost, client: client as unknown as EndHost };
}

const testKeys = {
  initial: { space: 'initial', key: 'k1', iv: 'iv1', headerProtectionKey: 'hp1' } as PacketProtectionKeys,
  application: { space: 'application', key: 'k2', iv: 'iv2', headerProtectionKey: 'hp2' } as PacketProtectionKeys,
};

const PORT = 9543;

const testKeyConfig = { mode: 'test-keys' as const, keys: testKeys };

function connectPair(server: EndHost, client: EndHost, bus: EventBus) {
  const serverConn = new QuicConnection(server, 'server', PORT, testKeyConfig, bus);
  const clientConn = new QuicConnection(client, 'client', PORT, testKeyConfig, bus);
  clientConn.connect('192.168.100.10', PORT);
  return { serverConn, clientConn };
}

describe('QuicConnection observability — quic.connection.* (RFC 9000 §5/§9/§10)', () => {
  it('publishes matching established events for both sides', () => {
    const { server, client } = topology();
    const bus = new EventBus();
    const events: QuicDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as QuicDomainEvent));

    const { serverConn, clientConn } = connectPair(server, client, bus);

    const established = events.filter((e) => e.topic === 'quic.connection.established');
    expect(established).toHaveLength(2);
    expect(established.map((e) => e.payload.connectionId).sort()).toEqual(
      [serverConn.connectionId, clientConn.connectionId].sort(),
    );
  });

  it('publishes connection.closing then connection.closed on a clean shutdown', () => {
    const { server, client } = topology();
    const bus = new EventBus();
    const events: QuicDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as QuicDomainEvent));
    const { serverConn, clientConn } = connectPair(server, client, bus);
    events.length = 0;

    clientConn.close(42, 'done');
    const now = Date.now();
    clientConn.advanceClosing(now + 5000);
    serverConn.advanceClosing(now + 5000);

    const clientClosing = events.find((e) => e.topic === 'quic.connection.closing' && e.payload.connectionId === clientConn.connectionId);
    const serverClosing = events.find((e) => e.topic === 'quic.connection.closing' && e.payload.connectionId === serverConn.connectionId);
    expect(clientClosing).toBeDefined();
    expect(serverClosing).toBeDefined();
    if (clientClosing?.topic === 'quic.connection.closing') {
      expect(clientClosing.payload.errorCode).toBe(42);
      expect(clientClosing.payload.reason).toBe('done');
    }

    const closedIds = events.filter((e) => e.topic === 'quic.connection.closed').map((e) => e.payload.connectionId);
    expect(closedIds.sort()).toEqual([serverConn.connectionId, clientConn.connectionId].sort());
  });
});

describe('QuicConnection observability — quic.packet.* (RFC 9000/9002)', () => {
  it('publishes packet.sent and packet.received for the handshake exchange', () => {
    const { server, client } = topology();
    const bus = new EventBus();
    const events: QuicDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as QuicDomainEvent));

    connectPair(server, client, bus);

    const sent = events.filter((e) => e.topic === 'quic.packet.sent');
    const received = events.filter((e) => e.topic === 'quic.packet.received');
    expect(sent.length).toBeGreaterThan(0);
    expect(received.length).toBeGreaterThan(0);
    if (sent[0]?.topic === 'quic.packet.sent') {
      expect(sent[0].payload.size).toBeGreaterThan(0);
      expect(['initial', 'handshake', 'application']).toContain(sent[0].payload.space);
    }
  });
});

describe('QuicConnection observability — quic.stream.* (RFC 9000 §2/§4)', () => {
  it('publishes stream.opened for a locally-opened stream and for a newly-observed peer stream', () => {
    const { server, client } = topology();
    const bus = new EventBus();
    const events: QuicDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as QuicDomainEvent));
    const { clientConn } = connectPair(server, client, bus);
    events.length = 0;

    const streamId = clientConn.openStream('bidirectional');
    const clientOpened = events.find((e) => e.topic === 'quic.stream.opened' && e.payload.connectionId === clientConn.connectionId);
    expect(clientOpened).toBeDefined();
    if (clientOpened?.topic === 'quic.stream.opened') expect(clientOpened.payload.streamId).toBe(streamId);

    clientConn.sendData(streamId, 'hello', true);
    const serverOpened = events.find((e) => e.topic === 'quic.stream.opened' && e.payload.streamId === streamId && e.payload.role === 'server');
    expect(serverOpened).toBeDefined();
  });

  it('publishes stream.closed once both sides have sent/received fin', () => {
    const { server, client } = topology();
    const bus = new EventBus();
    const events: QuicDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as QuicDomainEvent));
    const { serverConn, clientConn } = connectPair(server, client, bus);

    const streamId = clientConn.openStream('bidirectional');
    clientConn.sendData(streamId, 'bye', true);
    events.length = 0;
    // A stream only fully closes once both directions have seen a fin
    // (RFC 9000 §3.4/§3.5) — the server echoes its own fin back.
    serverConn.sendData(streamId, 'bye to you too', true);

    const clientClosed = events.find((e) => e.topic === 'quic.stream.closed' && e.payload.connectionId === clientConn.connectionId);
    const serverClosed = events.find((e) => e.topic === 'quic.stream.closed' && e.payload.connectionId === serverConn.connectionId);
    expect(clientClosed).toBeDefined();
    expect(serverClosed).toBeDefined();
  });

  it('publishes stream.blocked when a send exceeds the stream flow-control window', () => {
    const { server, client } = topology();
    const bus = new EventBus();
    const events: QuicDomainEvent[] = [];
    bus.subscribeAll((e) => events.push(e as QuicDomainEvent));
    const { clientConn } = connectPair(server, client, bus);

    const streamId = clientConn.openStream('bidirectional');
    clientConn.sendData(streamId, new Uint8Array(65535), false); // exhausts the default stream window
    events.length = 0;
    clientConn.sendData(streamId, new Uint8Array(1), false); // no window left at all

    const blocked = events.find((e) => e.topic === 'quic.stream.blocked');
    expect(blocked).toBeDefined();
    if (blocked?.topic === 'quic.stream.blocked') expect(blocked.payload.streamId).toBe(streamId);
  });
});

describe('QuicSignalStore / subscribeQuicObservables — read-model over quic.* topics', () => {
  it('tracks status, packet counters and open stream ids for a connection', () => {
    const { server, client } = topology();
    const bus = new EventBus();
    const store = new QuicSignalStore();
    subscribeQuicObservables(bus, store);
    const { serverConn, clientConn } = connectPair(server, client, bus);

    const signal = connectionSignal(store, clientConn.connectionId);
    expect(signal.get()?.status).toBe('established');
    expect(signal.get()?.packetsSent).toBeGreaterThan(0);

    const streamId = clientConn.openStream('bidirectional');
    expect(signal.get()?.openStreamIds).toContain(streamId);

    clientConn.sendData(streamId, 'closing this stream', true);
    serverConn.sendData(streamId, 'ack, closing too', true);
    expect(signal.get()?.openStreamIds).not.toContain(streamId);

    clientConn.close(0, 'bye');
    expect(signal.get()?.status).toBe('closing');
    clientConn.advanceClosing(Date.now() + 5000);
    expect(signal.get()?.status).toBe('closed');
  });
});
