/**
 * PRD-QUIC.md §5 P7 — connection state machine (RFC 9000 §5/§9/§10),
 * test-injected keys (no real TLS — that's P8). Real UDP transport
 * (EndHost.sendUdpDatagram/udpBind), real packet protection/framing,
 * multiplexed streams, and clean closing/draining shutdown.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { EndHost } from '@/network/devices/EndHost';
import { QuicConnection, type QuicMessage } from '@/network/quic/QuicConnection';
import type { PacketProtectionKeys } from '@/network/quic/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function topology() {
  const server = new LinuxPC('linux-pc', 'QSRV');
  const client = new LinuxPC('linux-pc', 'QCLIENT');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.99.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.99.20'), mask);
  return { server: server as unknown as EndHost, client: client as unknown as EndHost };
}

const testKeys = {
  initial: { space: 'initial', key: 'k1', iv: 'iv1', headerProtectionKey: 'hp1' } as PacketProtectionKeys,
  application: { space: 'application', key: 'k2', iv: 'iv2', headerProtectionKey: 'hp2' } as PacketProtectionKeys,
};

const PORT = 9443;

const testKeyConfig = { mode: 'test-keys' as const, keys: testKeys };

function connectPair(server: EndHost, client: EndHost) {
  const serverConn = new QuicConnection(server, 'server', PORT, testKeyConfig);
  const clientConn = new QuicConnection(client, 'client', PORT, testKeyConfig);
  clientConn.connect('192.168.99.10', PORT);
  return { serverConn, clientConn };
}

describe('QuicConnection — establishment with test keys', () => {
  it('both sides reach established after the minimal handshake exchange', () => {
    const { server, client } = topology();
    const { serverConn, clientConn } = connectPair(server, client);
    expect(clientConn.state).toBe('established');
    expect(serverConn.state).toBe('established');
  });
});

describe('QuicConnection — stream data exchange', () => {
  it('delivers a single stream message to the peer', () => {
    const { server, client } = topology();
    const { serverConn, clientConn } = connectPair(server, client);
    const received: QuicMessage[] = [];
    serverConn.onMessage((msg) => received.push(msg));

    const streamId = clientConn.openStream('bidirectional');
    clientConn.sendData(streamId, 'hello quic', true);

    expect(received).toHaveLength(1);
    expect(new TextDecoder().decode(received[0].data)).toBe('hello quic');
    expect(received[0].fin).toBe(true);
  });

  it('multiplexes two independent streams over the same connection', () => {
    const { server, client } = topology();
    const { serverConn, clientConn } = connectPair(server, client);
    const received: QuicMessage[] = [];
    serverConn.onMessage((msg) => received.push(msg));

    const s1 = clientConn.openStream('bidirectional');
    const s2 = clientConn.openStream('bidirectional');
    clientConn.sendData(s1, 'stream one', true);
    clientConn.sendData(s2, 'stream two', true);

    expect(received).toHaveLength(2);
    const byStream = new Map(received.map((m) => [m.streamId, new TextDecoder().decode(m.data)]));
    expect(byStream.get(s1)).toBe('stream one');
    expect(byStream.get(s2)).toBe('stream two');
  });

  it('data flows in both directions', () => {
    const { server, client } = topology();
    const { serverConn, clientConn } = connectPair(server, client);
    const clientReceived: QuicMessage[] = [];
    const serverReceived: QuicMessage[] = [];
    clientConn.onMessage((msg) => clientReceived.push(msg));
    serverConn.onMessage((msg) => serverReceived.push(msg));

    const clientStream = clientConn.openStream('bidirectional');
    clientConn.sendData(clientStream, 'ping', false);
    expect(serverReceived).toHaveLength(1);

    serverConn.sendData(clientStream, 'pong', true);
    expect(clientReceived).toHaveLength(1);
    expect(new TextDecoder().decode(clientReceived[0].data)).toBe('pong');
  });
});

describe('QuicConnection — clean shutdown (RFC 9000 §10)', () => {
  it('the initiator enters closing, the peer enters draining directly', () => {
    const { server, client } = topology();
    const { serverConn, clientConn } = connectPair(server, client);
    let serverClosedCode: number | null = null;
    serverConn.onClose((code) => { serverClosedCode = code; });

    clientConn.close(42, 'done');

    expect(clientConn.state).toBe('closing');
    expect(serverConn.state).toBe('draining');
    expect(serverClosedCode).toBe(42);
  });

  it('advanceClosing transitions to closed once the drain period elapses', () => {
    const { server, client } = topology();
    const { serverConn, clientConn } = connectPair(server, client);
    clientConn.close(0, 'bye');

    const now = Date.now();
    expect(clientConn.advanceClosing(now)).toBe(false);
    expect(clientConn.advanceClosing(now + 5000)).toBe(true);
    expect(clientConn.state).toBe('closed');

    expect(serverConn.advanceClosing(now + 5000)).toBe(true);
    expect(serverConn.state).toBe('closed');
  });
});
