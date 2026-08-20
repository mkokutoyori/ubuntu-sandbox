/**
 * PRD-TCP.md P8 — keepalive (RFC 9293 §3.8.4, SO_KEEPALIVE) + explicit
 * abort API.
 *
 * Before this phase, an `established` connection lived forever once idle
 * (no probe timer at all), and the only way to end a connection with an
 * RST was internal (receiving one from the peer/an ICMP) — there was no
 * `TcpSocket.abort()`/`reset()` for the application to call.
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

describe('TCP keepalive + explicit abort API (PRD-TCP.md P8)', () => {
  it('a healthy idle connection survives keepalive probing indefinitely', () => {
    const { cli, srv, scheduler } = buildPair();
    srv.getTcpStack().listen(8600, { onAccept: () => {} });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 8600)! as TcpSocket;
    clientSocket.enableKeepAlive(1000, 500, 3);

    // Well past several full idle+probe cycles' worth of time.
    scheduler.advance(10_000);

    expect(clientSocket.state).toBe('established');
    // Every probe got answered, so the failure count never accumulates.
    expect(clientSocket.keepAliveProbesSent).toBe(0);
  });

  it('a connection with a dead peer is closed as a timeout after maxProbes unanswered probes', () => {
    const { cli, srv, cable, scheduler } = buildPair();
    srv.getTcpStack().listen(8601, { onAccept: () => {} });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 8601)! as TcpSocket;
    clientSocket.enableKeepAlive(1000, 500, 3);
    let closedReason: string | null = null;
    clientSocket.onClose((r) => { closedReason = r; });

    cable.setPacketLossRate(1);
    cable.setRng(() => 0); // peer goes silent from here on
    scheduler.advance(1000 + 500 * 4 + 100);

    expect(clientSocket.state).toBe('closed');
    expect(closedReason).toBe('timeout');
    void srv;
  });

  it('disableKeepAlive() stops probing so an idle connection is left alone again', () => {
    const { cli, srv, scheduler } = buildPair();
    srv.getTcpStack().listen(8602, { onAccept: () => {} });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 8602)! as TcpSocket;
    clientSocket.enableKeepAlive(1000, 500, 3);
    clientSocket.disableKeepAlive();

    scheduler.advance(10_000);

    expect(clientSocket.state).toBe('established');
    void srv;
  });

  it('abort()/reset() sends an immediate RST and closes both ends without going through FIN-WAIT', () => {
    const { cli, srv, bus } = buildPair();
    let serverSocket: TcpSocket | null = null;
    srv.getTcpStack().listen(8603, { onAccept: (s) => { serverSocket = s as TcpSocket; } });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 8603)! as TcpSocket;
    expect(serverSocket).not.toBeNull();

    let clientClosedReason: string | null = null;
    clientSocket.onClose((r) => { clientClosedReason = r; });
    let serverClosedReason: string | null = null;
    serverSocket!.onClose((r) => { serverClosedReason = r; });
    const sentFlags: string[] = [];
    bus.subscribe('tcp.segment.sent', (e) => sentFlags.push((e.payload as { flagsText: string }).flagsText));

    clientSocket.abort();

    expect(clientSocket.state).toBe('closed');
    expect(clientClosedReason).toBe('rst');
    expect(serverSocket!.state).toBe('closed');
    expect(serverClosedReason).toBe('rst');
    expect(sentFlags.some((f) => f.includes('RST'))).toBe(true);
    expect(sentFlags.some((f) => f.includes('FIN'))).toBe(false);
  });

  it('reset() is the same operation as abort() under a different name', () => {
    const { cli, srv } = buildPair();
    srv.getTcpStack().listen(8604, { onAccept: () => {} });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 8604)! as TcpSocket;
    let closedReason: string | null = null;
    clientSocket.onClose((r) => { closedReason = r; });

    clientSocket.reset();

    expect(clientSocket.state).toBe('closed');
    expect(closedReason).toBe('rst');
    void srv;
  });
});
