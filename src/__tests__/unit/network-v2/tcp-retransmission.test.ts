/**
 * PRD-TCP.md P1 — real RTO-driven retransmission.
 *
 * Before this phase, `TcpStack` had no retransmission timer at all: a lost
 * SYN, data segment, or FIN was gone forever and the connection wedged
 * indefinitely. These tests drive real packet loss through `Cable`
 * (`setPacketLossRate`/`setRng`, not a mock) and a `VirtualTimeScheduler`
 * (fast-forwarded, no real wall-clock wait) to prove the RTO timer
 * actually recovers a lost segment, and that a connection with no way to
 * recover eventually gives up with `TcpCloseReason = 'timeout'` instead of
 * hanging forever.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { TcpSocket } from '@/network/tcp/TcpStack';
import type { TcpCloseReason } from '@/network/tcp/types';
import { TCP_INITIAL_RTO_MS, worstCaseRetransmitWindowMs } from '@/network/tcp/RttEstimator';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

/** Returns 0 exactly once (guarantees the next `Cable.transmit()` call is lost, given any lossRate > 0), then 1 forever after (never lost again). */
function lossOnceRng(): () => number {
  let calls = 0;
  return () => (calls++ === 0 ? 0 : 1);
}

/** Always below any positive loss rate — every subsequent frame on that cable is lost. */
function alwaysLossyRng(): () => number {
  return () => 0;
}

function buildPair() {
  const cli = new LinuxPC('CLI');
  const srv = new LinuxServer('linux-server', 'SRV');
  cli.powerOn(); srv.powerOn();
  const cable = new Cable('a');
  cable.connect(cli.getPort('eth0')!, srv.getPort('eth0')!);
  cli.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const scheduler = new VirtualTimeScheduler();
  cli.setScheduler(scheduler);
  srv.setScheduler(scheduler);
  return { cli, srv, cable, scheduler };
}

describe('TCP retransmission (PRD-TCP.md P1)', () => {
  it('a lost data segment is recovered by the RTO timer — the connection keeps making progress instead of hanging', () => {
    const { cli, srv, cable, scheduler } = buildPair();
    let accepted: TcpSocket | null = null;
    const received: unknown[] = [];
    srv.getTcpStack().listen(7000, { onAccept: (s) => { accepted = s; s.onData((d) => received.push(d)); } });

    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7000)!;
    expect(clientSocket.state).toBe('established');
    expect(accepted).not.toBeNull();

    // Force exactly the next frame on the wire (the data segment we're
    // about to send) to be lost — everything after that goes through.
    cable.setPacketLossRate(0.999);
    cable.setRng(lossOnceRng());
    clientSocket.send('hello world');
    expect(received).toEqual([]); // genuinely lost — not yet delivered

    // No progress until the RTO actually fires.
    scheduler.advance(TCP_INITIAL_RTO_MS - 10);
    expect(received).toEqual([]);

    // RTO fires — the segment is retransmitted and this time gets through.
    scheduler.advance(20);
    expect(received).toEqual(['hello world']);
    expect(clientSocket.state).toBe('established');
  });

  it('a lost SYN is recovered by the RTO timer — the handshake still completes', () => {
    const { cli, srv, cable, scheduler } = buildPair();
    let accepted: TcpSocket | null = null;
    srv.getTcpStack().listen(7001, { onAccept: (s) => { accepted = s; } });

    cable.setPacketLossRate(0.999);
    cable.setRng(lossOnceRng());
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7001)!;
    // The SYN was lost — nothing has happened yet synchronously.
    expect(clientSocket.state).toBe('syn-sent');
    expect(accepted).toBeNull();

    scheduler.advance(TCP_INITIAL_RTO_MS + 10);
    expect(clientSocket.state).toBe('established');
    expect(accepted).not.toBeNull();
    expect((accepted as unknown as TcpSocket).state).toBe('established');
  });

  it('exhausting all retransmissions aborts the connection with TcpCloseReason "timeout"', () => {
    const { cli, srv, cable, scheduler } = buildPair();
    srv.getTcpStack().listen(7002, { onAccept: () => {} });

    cable.setPacketLossRate(1);
    cable.setRng(alwaysLossyRng());
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7002)!;
    expect(clientSocket.state).toBe('syn-sent');

    let closeReason: TcpCloseReason | null = null;
    clientSocket.onClose((reason) => { closeReason = reason; });

    scheduler.advance(worstCaseRetransmitWindowMs() + 100);

    expect(clientSocket.state).toBe('closed');
    expect(closeReason).toBe('timeout');
  });

  it('a lost FIN is recovered by the RTO timer — the connection still reaches TIME-WAIT/closed instead of wedging in FIN-WAIT-1', () => {
    const { cli, srv, cable, scheduler } = buildPair();
    srv.getTcpStack().listen(7003, { onAccept: () => {} });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7003)!;
    expect(clientSocket.state).toBe('established');

    cable.setPacketLossRate(0.999);
    cable.setRng(lossOnceRng());
    clientSocket.close();
    expect(clientSocket.state).toBe('fin-wait-1');

    scheduler.advance(TCP_INITIAL_RTO_MS + 10);
    expect(['fin-wait-2', 'time-wait', 'closed']).toContain(clientSocket.state);
  });

  it('a normal (loss-free) connection is unaffected — no spurious retransmissions or timers left running', () => {
    const { cli, srv, scheduler } = buildPair();
    const received: unknown[] = [];
    srv.getTcpStack().listen(7004, { onAccept: (s) => { s.onData((d) => received.push(d)); } });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7004)!;
    clientSocket.send('no loss here');
    expect(received).toEqual(['no loss here']);

    // Advancing well past several RTOs must not do anything (queue should
    // already be empty — nothing left to retransmit).
    scheduler.advance(TCP_INITIAL_RTO_MS * 10);
    expect(received).toEqual(['no loss here']);
    expect(clientSocket.state).toBe('established');
  });
});
