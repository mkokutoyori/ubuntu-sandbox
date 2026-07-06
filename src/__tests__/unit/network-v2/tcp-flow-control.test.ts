/**
 * PRD-TCP.md P3 — real flow control.
 *
 * Before this phase, `_sendData` blasted MSS-sized segments in a tight
 * loop without ever consulting the peer's advertised `window` — a slow
 * receiver with a small buffer had no way to actually throttle a fast
 * sender, and a zero-window receiver would just get flooded anyway.
 * These tests drive a real small/zero receive window (`TcpSocket.windowSize`
 * on the accepting socket) through two real `LinuxPC`/`LinuxServer`
 * instances and check the sender actually respects it, including the
 * zero-window persist probe (RFC 9293 §3.8.6.1).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import type { TcpSegmentSentPayload } from '@/network/tcp/events';
import { TCP_INITIAL_RTO_MS } from '@/network/tcp/RttEstimator';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function buildPair() {
  const bus = new EventBus();
  const cli = new LinuxPC('CLI');
  const srv = new LinuxServer('linux-server', 'SRV');
  cli.setEventBus(bus); srv.setEventBus(bus);
  cli.powerOn(); srv.powerOn();
  const cable = new Cable('a');
  cable.setEventBus(bus);
  cable.connect(cli.getPort('eth0')!, srv.getPort('eth0')!);
  cli.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const scheduler = new VirtualTimeScheduler();
  cli.setScheduler(scheduler);
  srv.setScheduler(scheduler);
  return { cli, srv, bus, scheduler };
}

describe('TCP flow control (PRD-TCP.md P3)', () => {
  it('a small receive window forces the sender to split data into window-sized segments instead of one big blast', () => {
    const { cli, srv, bus } = buildPair();
    let serverSocket: TcpSocket | null = null;
    const received: string[] = [];
    srv.getTcpStack().listen(7100, {
      onAccept: (s) => {
        serverSocket = s;
        s.windowSize = 10;
        s.onData((d) => received.push(d as string));
      },
    });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7100)!;
    expect(clientSocket.state).toBe('established');
    expect(serverSocket).not.toBeNull();

    const dataSizes: number[] = [];
    bus.subscribe('tcp.segment.sent', (e) => {
      const p = e.payload as TcpSegmentSentPayload;
      if (p.sourcePort === clientSocket.localPort && p.payloadSize > 0) dataSizes.push(p.payloadSize);
    });

    clientSocket.send('A'.repeat(50));

    expect(received.join('')).toBe('A'.repeat(50));
    expect(dataSizes.length).toBeGreaterThan(1); // never one 50-byte blast
    for (const size of dataSizes) expect(size).toBeLessThanOrEqual(10);
  });

  it('a zero window blocks all new sends until a persist probe reveals it has reopened', () => {
    const { cli, srv, scheduler } = buildPair();
    let serverSocket: TcpSocket | null = null;
    const received: string[] = [];
    srv.getTcpStack().listen(7101, {
      onAccept: (s) => {
        serverSocket = s;
        s.windowSize = 0;
        s.onData((d) => received.push(d as string));
      },
    });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7101)!;
    expect(clientSocket.state).toBe('established');

    clientSocket.send('hello');
    expect(received).toEqual([]);
    expect(clientSocket.sendBacklog.length).toBeGreaterThan(0);
    expect(clientSocket.persistTimer).not.toBeNull();

    // The peer reopens its window; only a persist probe will reveal this
    // (nothing else is scheduled to talk to the client right now).
    serverSocket!.windowSize = 100;
    scheduler.advance(TCP_INITIAL_RTO_MS + 10);

    expect(received.join('')).toBe('hello');
    expect(clientSocket.persistTimer).toBeNull();
  });

  it('a normal, healthy window is unaffected — no unnecessary splitting or persist probing (regression)', () => {
    const { cli, srv } = buildPair();
    const received: string[] = [];
    srv.getTcpStack().listen(7102, { onAccept: (s) => { s.onData((d) => received.push(d as string)); } });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7102)!;
    clientSocket.send('no throttling needed here');
    expect(received.join('')).toBe('no throttling needed here');
    expect(clientSocket.sendBacklog).toEqual([]);
    expect(clientSocket.persistTimer).toBeNull();
  });
});
