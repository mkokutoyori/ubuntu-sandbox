/**
 * PRD-TCP.md P5 — RFC 5681 congestion control.
 *
 * Before this phase, `_sendData`/`flushSendBacklog` only ever consulted
 * the peer's advertised window (P3) — there was no `cwnd`/`ssthresh` at
 * all, no slow start, and no fast retransmit: a segment lost mid-burst
 * could only ever be recovered by waiting out a full RTO cycle (P1),
 * never by the 3-duplicate-ACK fast path real TCP uses to recover in a
 * fraction of the time.
 *
 * The fast-retransmit scaffold below was re-measured once the receiver
 * started delaying its ACKs (RFC 5681 §4.2, one ACK per two full-sized
 * segments). Measured `tcp.segment.sent` interleaving for a 12000-byte
 * stream over an MSS of 1460, on a bare cable pair with no L2 chatter
 * left after `connect()` returns:
 *
 *   C1460 C1460 S0 C1460 C1460 S0 C1460 C1460 S0 C1460 C1460 S0 C320 S0
 *
 * so cable call #2 is the client's 2nd data segment. Dropping it leaves
 * the 3rd/4th/5th/6th arriving out of order; the first of those flushes
 * the ACK still owed for segment #1 (a real stack subsumes the delayed
 * ACK into the immediate out-of-order one rather than sending two), so
 * the 3rd DUPLICATE only lands on the 6th segment — one segment later
 * than before delayed ACK existed, which is why the 6000-byte stream the
 * old scaffold used is now too short to reach fast retransmit at all.
 * At that instant SND.UNA/SND.NXT were measured 5841 apart (the +1 is
 * the SYN's own sequence number), and the figure is set by `cwnd`, not
 * by the stream length: 12000, 20000 and 30000 bytes all measure 5841.
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

    let calls = 0;
    const flightAtRetransmit: number[] = [];
    bus.subscribe('tcp.retransmit', () => {
      flightAtRetransmit.push((clientSocket.sendNext - clientSocket.sendUnacked) >>> 0);
    });
    cable.setPacketLossRate(0.999);
    cable.setRng(() => (++calls === 2 ? 0 : 1));

    clientSocket.send('B'.repeat(12_000));

    expect(retransmits.length).toBeGreaterThan(0);
    expect(flightAtRetransmit[0]).toBe(5841);
    expect(clientSocket.cc.ssthresh).toBe(Math.max(Math.floor(5841 / 2), 2 * clientSocket.mss));
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
      onAccept: (s) => { serverSocket = s; s.windowSize = 5 * 128; s.onData((d) => received.push(d as string)); },
    });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7304)!;
    expect(serverSocket).not.toBeNull();
    // 5 × 128: RFC 7323 window scale is always negotiated between two of
    // this simulator's own hosts.
    expect(clientSocket.cc.cwnd).toBeGreaterThan(1000);

    clientSocket.send('hello world');
    expect(received.join('')).toBe('hello world');
  });
});
