import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { flagsString, noFlags, makeSocketKey, makeListenerKey, TCP_MSL_MS } from '@/network/tcp/types';
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

describe('TCP — connection close', () => {
  it('client.close() drives FIN → FIN-ACK → ACK; active closer parks in TIME_WAIT, passive closer closes', () => {
    const { bus, client, server } = pair();
    let serverSocket: TcpSocket | null = null;
    server.getTcpStack().listen(49, { onAccept: (s) => { serverSocket = s; } });
    const cs = client.getTcpStack().connect('10.0.0.2', 49)!;
    const closedEvents: Array<{ deviceId: string; reason: string }> = [];
    bus.subscribe('tcp.connection.closed', (e) => closedEvents.push(e.payload));
    cs.close();
    if (serverSocket && (serverSocket as TcpSocket).state === 'close-wait') (serverSocket as TcpSocket).close();
    expect(cs.state).toBe('time-wait');
    expect((serverSocket as unknown as TcpSocket).state).toBe('closed');
    expect(closedEvents.some(c => c.deviceId === client.id)).toBe(true);
  });

  it('server-initiated close also tears the connection down on the client', () => {
    const { client, server } = pair();
    let serverSocket: TcpSocket | null = null;
    server.getTcpStack().listen(49, { onAccept: (s) => { serverSocket = s; } });
    const cs = client.getTcpStack().connect('10.0.0.2', 49)!;
    serverSocket!.close();
    if (cs.state === 'close-wait') cs.close();
    expect(cs.state).toBe('closed');
    expect(serverSocket!.state).toBe('time-wait');
  });
});

describe('TCP — TIME_WAIT (RFC 793 §3.5)', () => {
  let vts: VirtualTimeScheduler;

  beforeEach(() => {
    vts = new VirtualTimeScheduler();
    __setDefaultScheduler(vts);
  });

  afterEach(() => {
    __setDefaultScheduler(null);
  });

  function closedPair() {
    const built = pair();
    let serverSocket: TcpSocket | null = null;
    built.server.getTcpStack().listen(49, { onAccept: (s) => { serverSocket = s; } });
    const cs = built.client.getTcpStack().connect('10.0.0.2', 49)!;
    cs.close();
    (serverSocket as unknown as TcpSocket).close();
    return { ...built, cs, serverSocket: serverSocket as unknown as TcpSocket };
  }

  it('the socket pair stays reserved for 2×MSL then is released', () => {
    const { client, cs } = closedPair();
    expect(cs.state).toBe('time-wait');
    expect(client.getTcpStack().listSockets()).toHaveLength(1);

    vts.advance(2 * TCP_MSL_MS - 1);
    expect(cs.state).toBe('time-wait');

    vts.advance(1);
    expect(cs.state).toBe('closed');
    expect(client.getTcpStack().listSockets()).toHaveLength(0);
  });

  it('the application close handler fires immediately, not after 2MSL', () => {
    const built = pair();
    let serverSocket: TcpSocket | null = null;
    built.server.getTcpStack().listen(49, { onAccept: (s) => { serverSocket = s; } });
    let closeReason: string | null = null;
    const cs = built.client.getTcpStack().connect('10.0.0.2', 49, {
      onClose: (reason) => { closeReason = reason; },
    })!;
    cs.close();
    (serverSocket as unknown as TcpSocket).close();
    expect(closeReason).toBe('fin');
  });

  it('a retransmitted remote FIN in TIME_WAIT is re-ACKed and restarts the 2MSL timer', () => {
    const { bus, client, cs } = closedPair();
    vts.advance(2 * TCP_MSL_MS - 1000);

    const acks: string[] = [];
    bus.subscribe('tcp.segment.sent', (e) => {
      if (e.payload.deviceId === client.id) acks.push(e.payload.flagsText);
    });
    // Simulate the loss of our final ACK: the server retransmits its FIN.
    const finFlags = noFlags(); finFlags.fin = true; finFlags.ack = true;
    const seg = {
      type: 'tcp' as const,
      sourcePort: 49, destinationPort: cs.localPort,
      sequence: cs.recvNext === 0 ? 0 : (cs.recvNext - 1) >>> 0,
      acknowledgement: cs.sendNext,
      dataOffset: 5, flags: finFlags, window: 65535, checksum: 0,
      urgentPointer: 0, options: [], payload: undefined,
    };
    const ipPkt = {
      type: 'ipv4' as const, version: 4, ihl: 5, tos: 0, totalLength: 40,
      identification: 1, flags: 0, fragmentOffset: 0, ttl: 64,
      protocol: 6, headerChecksum: 0,
      sourceIP: new IPAddress('10.0.0.2'), destinationIP: new IPAddress('10.0.0.1'),
      payload: seg,
    };
    client.getTcpStack().handleIp('GigabitEthernet0/0', new IPAddress('10.0.0.2'), ipPkt);

    expect(acks).toContain('ACK');
    // Timer restarted: 1s later (old deadline) the socket is still reserved.
    vts.advance(1000);
    expect(cs.state).toBe('time-wait');
    vts.advance(2 * TCP_MSL_MS);
    expect(cs.state).toBe('closed');
  });

  it('the passive closer (LAST_ACK) closes immediately without TIME_WAIT', () => {
    const { serverSocket } = closedPair();
    expect(serverSocket.state).toBe('closed');
  });

  it('stack stop() releases TIME_WAIT sockets without firing duplicate close events', () => {
    const { bus, client, cs } = closedPair();
    const closes: string[] = [];
    bus.subscribe('tcp.connection.closed', (e) => {
      if (e.payload.deviceId === client.id) closes.push(e.payload.reason);
    });
    client.getTcpStack().stop();
    expect(cs.state).toBe('closed');
    expect(closes).toHaveLength(0);
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
