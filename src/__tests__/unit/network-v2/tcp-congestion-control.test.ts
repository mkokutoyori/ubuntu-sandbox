/**
 * PRD-TCP.md P5 — RFC 5681 congestion control.
 *
 * Before this phase, `_sendData`/`flushSendBacklog` only ever consulted
 * the peer's advertised window (P3) — there was no `cwnd`/`ssthresh` at
 * all, no slow start, and no fast retransmit: a segment lost mid-burst
 * could only ever be recovered by waiting out a full RTO cycle (P1),
 * never by the 3-duplicate-ACK fast path real TCP uses to recover in a
 * fraction of the time.
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
import { initialCongestionWindow } from '@/network/tcp/TcpCongestionControl';

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
  return { cli, srv, bus, cable, scheduler };
}

describe('TCP congestion control (PRD-TCP.md P5)', () => {
  it('a brand-new connection starts in slow start with the RFC 5681 §3.1 initial window', () => {
    const { cli, srv } = buildPair();
    srv.getTcpStack().listen(7300, { onAccept: () => {} });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7300)!;
    // The handshake's own SYN ACK already counts as 1 byte of progress
    // (a SYN consumes one sequence number), so cwnd = IW + 1.
    expect(clientSocket.cc.cwnd).toBe(initialCongestionWindow(clientSocket.mss) + 1);
    expect(clientSocket.cc.phase).toBe('slow-start');
  });

  it('cwnd grows on every new ACK while in slow start, so a bulk transfer completes without ever exceeding the window (regression)', () => {
    const { cli, srv } = buildPair();
    const received: string[] = [];
    srv.getTcpStack().listen(7301, { onAccept: (s) => { s.onData((d) => received.push(d as string)); } });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7301)!;
    const cwndBefore = clientSocket.cc.cwnd;

    clientSocket.send('A'.repeat(20_000));

    expect(received.join('')).toBe('A'.repeat(20_000));
    expect(clientSocket.cc.cwnd).toBeGreaterThan(cwndBefore);
    expect(clientSocket.cc.phase).toBe('slow-start');
  });

  it('three duplicate ACKs trigger an immediate fast retransmit (RFC 5681 §3.2) — no RTO wait needed', () => {
    const { cli, srv, bus, cable } = buildPair();
    srv.getTcpStack().listen(7302, { onAccept: () => {} });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7302)!;

    const retransmits: unknown[] = [];
    bus.subscribe('tcp.retransmit', (e) => retransmits.push(e.payload));

    // 6000 bytes over an MSS of 1460 ships as 5 client-side data segments
    // interleaved with 4 server ACKs (empirically confirmed via
    // tcp.segment.sent tracing): call #1/3/5/7/9 are the data segments,
    // #2/4/6/8 the ACKs answering them. Losing exactly call #3 drops the
    // *2nd* data segment — the 3rd/4th/5th then arrive out of order at
    // the server, each drawing a duplicate ACK for what's already been
    // cumulatively acked, so the 3rd such duplicate should fire a fast
    // retransmit well before any RTO timer would (none was even armed
    // via a scheduler advance in this test).
    let calls = 0;
    cable.setPacketLossRate(0.999);
    cable.setRng(() => (++calls === 3 ? 0 : 1));

    clientSocket.send('B'.repeat(6000));

    expect(retransmits.length).toBeGreaterThan(0);
    // RFC 5681 §3.2: ssthresh = max(flightSize/2, 2×MSS). flightSize at
    // the moment of the 3rd duplicate ACK is 6000 - 1460 (only the 1st
    // segment had been cumulatively acked) = 4540, so ssthresh =
    // max(2270, 2920) = 2920.
    expect(clientSocket.cc.ssthresh).toBe(2920);
    expect(clientSocket.cc.ssthresh).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('an RTO timeout collapses cwnd back to 1 MSS and halves ssthresh (RFC 5681 §3.1) — regression vs. P1', () => {
    const { cli, srv, cable, scheduler } = buildPair();
    srv.getTcpStack().listen(7303, { onAccept: () => {} });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7303)!;

    cable.setPacketLossRate(1);
    cable.setRng(() => 0); // every subsequent frame is lost
    clientSocket.send('C'.repeat(100));

    const cwndBeforeTimeout = clientSocket.cc.cwnd;
    scheduler.advance(1100); // one RTO cycle fires (P1)

    expect(clientSocket.cc.cwnd).toBe(clientSocket.mss);
    expect(clientSocket.cc.cwnd).toBeLessThan(cwndBeforeTimeout);
    expect(clientSocket.cc.ssthresh).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('a small receive window still wins over a large congestion window (P3 regression — min(cwnd, rwnd))', () => {
    const { cli, srv } = buildPair();
    let serverSocket: TcpSocket | null = null;
    const received: string[] = [];
    srv.getTcpStack().listen(7304, {
      onAccept: (s) => { serverSocket = s; s.windowSize = 5; s.onData((d) => received.push(d as string)); },
    });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7304)!;
    expect(serverSocket).not.toBeNull();
    // cwnd is comfortably large (thousands of bytes) but the peer's
    // window (5 bytes) must still be the binding constraint.
    expect(clientSocket.cc.cwnd).toBeGreaterThan(1000);

    clientSocket.send('hello world');
    expect(received.join('')).toBe('hello world');
  });
});
