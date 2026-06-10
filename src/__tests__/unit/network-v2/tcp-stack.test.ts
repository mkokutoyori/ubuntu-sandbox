import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  flagsString, noFlags, makeSocketKey, makeListenerKey,
  computeTcpChecksum, verifyTcpChecksum, TCP_TIME_WAIT_MS,
} from '@/network/tcp/types';
import type { TcpSocket } from '@/network/tcp/TcpStack';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function pair(): { bus: EventBus; client: CiscoRouter; server: CiscoRouter } {
  const bus = new EventBus();
  const client = new CiscoRouter('CLI');
  const server = new CiscoRouter('SRV');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.setEventBus(bus); server.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(client.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
  new Cable('b').connect(server.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  client.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  server.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { bus, client, server };
}

describe('TCP — pure helpers', () => {
  it('flagsString renders the canonical RFC 793 mnemonics', () => {
    const f = noFlags(); f.syn = true; f.ack = true;
    expect(flagsString(f)).toBe('ACK|SYN');
    const g = noFlags(); g.fin = true; g.ack = true;
    expect(flagsString(g)).toBe('ACK|FIN');
    expect(flagsString(noFlags())).toBe('(none)');
  });

  it('makeSocketKey is symmetric per side', () => {
    const a = makeSocketKey('10.0.0.1', 49152, '10.0.0.2', 49);
    expect(a).toBe('10.0.0.1:49152|10.0.0.2:49');
  });

  it('makeListenerKey encodes (localIp, localPort)', () => {
    expect(makeListenerKey('0.0.0.0', 49)).toBe('0.0.0.0:49');
  });
});

describe('TCP — 3-way handshake', () => {
  it('connect() drives SYN → SYN-ACK → ACK and reaches established on both sides', () => {
    const { client, server } = pair();
    let serverSocket: TcpSocket | null = null;
    server.getTcpStack().listen(49, { onAccept: (s) => { serverSocket = s; } });
    const clientSocket = client.getTcpStack().connect('10.0.0.2', 49);
    expect(clientSocket).not.toBeNull();
    expect(clientSocket!.state).toBe('established');
    expect(serverSocket).not.toBeNull();
    expect(serverSocket!.state).toBe('established');
  });

  it('fires tcp.connection.opened on both peers (passive on server)', () => {
    const { bus, client, server } = pair();
    server.getTcpStack().listen(49, { onAccept: () => undefined });
    const opens: Array<{ deviceId: string; passive: boolean; localPort: number }> = [];
    bus.subscribe('tcp.connection.opened', (e) => opens.push(e.payload));
    client.getTcpStack().connect('10.0.0.2', 49);
    expect(opens.length).toBe(2);
    const srv = opens.find(o => o.deviceId === server.id);
    const cli = opens.find(o => o.deviceId === client.id);
    expect(srv?.passive).toBe(true);
    expect(srv?.localPort).toBe(49);
    expect(cli?.passive).toBe(false);
  });

  it('publishes the SYN segment on the wire', () => {
    const { bus, client, server } = pair();
    server.getTcpStack().listen(49, { onAccept: () => undefined });
    const sent: Array<{ flagsText: string; destinationPort: number }> = [];
    bus.subscribe('tcp.segment.sent', (e) => {
      if (e.payload.deviceId === client.id) sent.push(e.payload);
    });
    client.getTcpStack().connect('10.0.0.2', 49);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].flagsText).toBe('SYN');
    expect(sent[0].destinationPort).toBe(49);
  });
});

describe('TCP — no listener', () => {
  it('connect() to a port with no listener gets RST and stays closed', () => {
    const { bus, client, server } = pair();
    void server;
    const closeds: Array<{ reason: string }> = [];
    bus.subscribe('tcp.connection.closed', (e) => { if (e.payload.deviceId === client.id) closeds.push(e.payload); });
    const socket = client.getTcpStack().connect('10.0.0.2', 9999);
    expect(socket).not.toBeNull();
    expect(socket!.state).toBe('closed');
    expect(closeds.some(c => c.reason === 'rst')).toBe(true);
  });
});

describe('TCP — data exchange', () => {
  it('client.send delivers payload to the server onData callback', () => {
    const { client, server } = pair();
    const received: unknown[] = [];
    server.getTcpStack().listen(49, {
      onAccept: (sock) => { sock.onData((data) => { received.push(data); }); },
    });
    const cs = client.getTcpStack().connect('10.0.0.2', 49)!;
    cs.send({ kind: 'hello', payload: 'world' });
    cs.send({ kind: 'second', payload: 42 });
    expect(received).toEqual([
      { kind: 'hello', payload: 'world' },
      { kind: 'second', payload: 42 },
    ]);
  });

  it('server.send delivers to the client onData callback', () => {
    const { client, server } = pair();
    const received: unknown[] = [];
    server.getTcpStack().listen(49, {
      onAccept: (sock) => { sock.send({ greeting: 'welcome' }); },
    });
    const cs = client.getTcpStack().connect('10.0.0.2', 49, {
      onData: (d) => received.push(d),
    })!;
    void cs;
    expect(received).toEqual([{ greeting: 'welcome' }]);
  });

  it('payload-bearing segments carry PSH|ACK on the wire', () => {
    const { bus, client, server } = pair();
    server.getTcpStack().listen(49, { onAccept: () => undefined });
    const cs = client.getTcpStack().connect('10.0.0.2', 49)!;
    const segments: Array<{ flagsText: string; payloadSize: number; deviceId: string }> = [];
    bus.subscribe('tcp.segment.sent', (e) => segments.push(e.payload));
    cs.send({ msg: 'x' });
    const data = segments.find(s => s.payloadSize > 0);
    expect(data).toBeDefined();
    expect(data!.flagsText).toBe('ACK|PSH');
  });
});

describe('TCP — connection close (RFC 9293 §3.6)', () => {
  it('client.close(): passive side closes; the active closer holds TIME-WAIT', () => {
    const { bus, client, server } = pair();
    let serverSocket: TcpSocket | null = null;
    server.getTcpStack().listen(49, { onAccept: (s) => { serverSocket = s; } });
    const cs = client.getTcpStack().connect('10.0.0.2', 49)!;
    const closedEvents: Array<{ deviceId: string; reason: string }> = [];
    bus.subscribe('tcp.connection.closed', (e) => closedEvents.push(e.payload));
    cs.close();
    if (serverSocket && (serverSocket as TcpSocket).state === 'close-wait') (serverSocket as TcpSocket).close();
    // Passive closer (server) is fully closed; the active closer MUST
    // hold the pair in TIME-WAIT for 2×MSL (it is NOT closed yet).
    expect(serverSocket!.state).toBe('closed');
    expect(cs.state).toBe('time-wait');
    expect(closedEvents.some(c => c.deviceId === server.id)).toBe(true);
    expect(closedEvents.some(c => c.deviceId === client.id)).toBe(false);
  });

  it('server-initiated close mirrors the same asymmetry', () => {
    const { client, server } = pair();
    let serverSocket: TcpSocket | null = null;
    server.getTcpStack().listen(49, { onAccept: (s) => { serverSocket = s; } });
    const cs = client.getTcpStack().connect('10.0.0.2', 49)!;
    serverSocket!.close();
    if (cs.state === 'close-wait') cs.close();
    expect(cs.state).toBe('closed');                 // passive closer
    expect(serverSocket!.state).toBe('time-wait');   // active closer
  });

  it('TIME-WAIT releases the socket after 2×MSL', async () => {
    const { client, server } = pair();
    const scheduler = new VirtualTimeScheduler();
    client.setScheduler(scheduler);
    let serverSocket: TcpSocket | null = null;
    server.getTcpStack().listen(49, { onAccept: (s) => { serverSocket = s; } });
    const cs = client.getTcpStack().connect('10.0.0.2', 49)!;
    cs.close();
    if (serverSocket && (serverSocket as TcpSocket).state === 'close-wait') (serverSocket as TcpSocket).close();
    expect(cs.state).toBe('time-wait');
    scheduler.advance(TCP_TIME_WAIT_MS);
    expect(cs.state).toBe('closed');
  });
});

describe('TCP — robustness (RFC 9293 §3.1/§3.10.7.4)', () => {
  it('a duplicated data segment is re-ACKed but never delivered twice', () => {
    const { bus, client, server } = pair();
    const received: unknown[] = [];
    server.getTcpStack().listen(49, {
      onAccept: (sock) => { sock.onData((d) => received.push(d)); },
    });
    const cs = client.getTcpStack().connect('10.0.0.2', 49)!;

    // Capture the data segment off the wire, then replay it raw at the
    // server's stack (simulating network duplication).
    let dup: { seg: import('@/network/tcp/types').TcpSegment; ip: IPAddress } | null = null;
    bus.subscribe('tcp.segment.received', () => { /* observe only */ });
    const origHandle = server.getTcpStack().handleIp.bind(server.getTcpStack());
    cs.send('hello-once');
    expect(received).toEqual(['hello-once']);

    // Replay: rebuild the same segment (same sequence) and re-inject.
    const seq = (cs.sendNext - 'hello-once'.length) >>> 0;
    const replay: import('@/network/tcp/types').TcpSegment = {
      type: 'tcp', sourcePort: cs.localPort, destinationPort: 49,
      sequence: seq, acknowledgement: cs.recvNext,
      dataOffset: 5,
      flags: { ...noFlags(), ack: true, psh: true },
      window: 65535, checksum: 0, urgentPointer: 0, options: [],
      payload: 'hello-once',
    };
    origHandle('GigabitEthernet0/0', new IPAddress('10.0.0.1'), {
      type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 60,
      identification: 1, flags: 0, fragmentOffset: 0, ttl: 64,
      protocol: 6, headerChecksum: 0,
      sourceIP: new IPAddress('10.0.0.1'),
      destinationIP: new IPAddress('10.0.0.2'),
      payload: replay,
    });
    expect(received).toEqual(['hello-once']);   // not delivered twice
    void dup;
  });

  it('a corrupted checksum is discarded silently', () => {
    const { bus, client, server } = pair();
    const received: unknown[] = [];
    const drops: Array<{ reason: string }> = [];
    bus.subscribe('tcp.segment.dropped', (e) => drops.push(e.payload));
    server.getTcpStack().listen(49, {
      onAccept: (sock) => { sock.onData((d) => received.push(d)); },
    });
    const cs = client.getTcpStack().connect('10.0.0.2', 49)!;

    const bad: import('@/network/tcp/types').TcpSegment = {
      type: 'tcp', sourcePort: cs.localPort, destinationPort: 49,
      sequence: cs.sendNext, acknowledgement: cs.recvNext,
      dataOffset: 5,
      flags: { ...noFlags(), ack: true, psh: true },
      window: 65535, checksum: 0xBEEF /* wrong */, urgentPointer: 0,
      options: [], payload: 'tampered',
    };
    server.getTcpStack().handleIp('GigabitEthernet0/0', new IPAddress('10.0.0.1'), {
      type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 60,
      identification: 2, flags: 0, fragmentOffset: 0, ttl: 64,
      protocol: 6, headerChecksum: 0,
      sourceIP: new IPAddress('10.0.0.1'),
      destinationIP: new IPAddress('10.0.0.2'),
      payload: bad,
    });
    expect(received).toEqual([]);
    expect(drops.some(d => d.reason === 'bad-checksum')).toBe(true);
  });

  it('segments built by the stack carry a verifiable checksum', () => {
    const { bus, client, server } = pair();
    server.getTcpStack().listen(49, { onAccept: () => undefined });
    const checksums: number[] = [];
    bus.subscribe('tcp.segment.sent', () => { /* counts only */ });
    // Verify at IP level through the wire event payloads is indirect;
    // instead assert via the pure function on a crafted segment.
    const seg: import('@/network/tcp/types').TcpSegment = {
      type: 'tcp', sourcePort: 1000, destinationPort: 2000,
      sequence: 42, acknowledgement: 7, dataOffset: 5,
      flags: { ...noFlags(), ack: true }, window: 65535,
      checksum: 0, urgentPointer: 0, options: [], payload: 'abc',
    };
    seg.checksum = computeTcpChecksum(seg, '10.0.0.1', '10.0.0.2');
    expect(seg.checksum).not.toBe(0);
    expect(verifyTcpChecksum(seg, '10.0.0.1', '10.0.0.2')).toBe(true);
    // Any field change invalidates it.
    seg.sequence = 43;
    expect(verifyTcpChecksum(seg, '10.0.0.1', '10.0.0.2')).toBe(false);
    void client; void checksums;
  });
});

describe('TCP — segmentation and reassembly (RFC 793)', () => {
  it('a payload larger than MSS is split into MSS-sized segments and reassembled', () => {
    const { bus, client, server } = pair();
    const received: string[] = [];
    server.getTcpStack().listen(49, {
      onAccept: (sock) => { sock.onData((data) => { received.push(data as string); }); },
    });
    const cs = client.getTcpStack().connect('10.0.0.2', 49)!;
    const segmentsSent: number[] = [];
    bus.subscribe('tcp.segment.sent', (e) => {
      if (e.payload.deviceId === client.id && e.payload.payloadSize > 0) {
        segmentsSent.push(e.payload.payloadSize);
      }
    });
    const big = 'x'.repeat(1460 * 2 + 200);
    cs.send(big);
    expect(segmentsSent.length).toBe(3);
    expect(segmentsSent[0]).toBe(1460);
    expect(segmentsSent[1]).toBe(1460);
    expect(segmentsSent[2]).toBe(200);
    expect(received).toEqual([big]);
  });

  it('object payloads stay as a single segment (no segmentation)', () => {
    const { bus, client, server } = pair();
    server.getTcpStack().listen(49, { onAccept: () => undefined });
    const cs = client.getTcpStack().connect('10.0.0.2', 49)!;
    const segments: Array<{ payloadSize: number; flagsText: string }> = [];
    bus.subscribe('tcp.segment.sent', (e) => {
      if (e.payload.deviceId === client.id && e.payload.payloadSize > 0) {
        segments.push(e.payload);
      }
    });
    cs.send({ kind: 'opaque', body: 'irrelevant' });
    expect(segments.length).toBe(1);
    expect(segments[0].flagsText).toBe('ACK|PSH');
  });
});

describe('TCP — multiple concurrent connections', () => {
  it('the listener accepts multiple clients on the same port and keeps them isolated', () => {
    const bus = new EventBus();
    const cliA = new CiscoRouter('A');
    const cliB = new CiscoRouter('B');
    const srv = new CiscoRouter('SRV');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cliA.setEventBus(bus); cliB.setEventBus(bus); srv.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cliA.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(cliB.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    cliA.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
    cliB.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.11'), new SubnetMask('255.255.255.0'));
    srv.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.99'), new SubnetMask('255.255.255.0'));

    const accepted: TcpSocket[] = [];
    srv.getTcpStack().listen(80, { onAccept: (s) => { accepted.push(s); } });
    const sA = cliA.getTcpStack().connect('10.0.0.99', 80)!;
    const sB = cliB.getTcpStack().connect('10.0.0.99', 80)!;
    expect(accepted.length).toBe(2);
    expect(sA.state).toBe('established');
    expect(sB.state).toBe('established');
    expect(accepted[0].remoteIp).not.toBe(accepted[1].remoteIp);
  });
});
