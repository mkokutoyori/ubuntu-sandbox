/**
 * PRD-TCP.md P2 — `EndHost.tcpConnect()` genuinely waits for the handshake
 * to resolve instead of judging it in the same synchronous tick.
 *
 * Before this phase, `tcpConnect()` called `TcpStack.connect()` and
 * immediately read `socket.state` in the same call stack — a SYN lost on
 * a lossy link (delivered synchronously, so nothing comes back within the
 * tick) was reported as a failure (`null`) instantly, even though P1's RTO
 * retransmission machinery might recover it moments later. These tests
 * drive real packet loss through `Cable` and a `VirtualTimeScheduler`
 * (fast-forwarded, no real wall-clock wait) to prove `tcpConnect()` now
 * actually waits for the real outcome.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { TCP_INITIAL_RTO_MS, worstCaseRetransmitWindowMs } from '@/network/tcp/RttEstimator';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function lossOnceRng(): () => number {
  let calls = 0;
  return () => (calls++ === 0 ? 0 : 1);
}

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
  // Pre-warm ARP both ways (a real link would already have these from a
  // prior exchange) so the lossy-cable scenarios below exercise TCP-level
  // SYN loss/retransmission specifically, not the separate, single-shot,
  // non-retrying ARP-request-queue that `sendIpv4FrameArpAware` now goes
  // through on a cold cache (PRD audit #26) — that queue's own fixed 2s
  // timeout has nothing to do with TCP's RTO and would otherwise eat the
  // "lost exactly once" RNG slot this test is built around.
  cli.addStaticARP(new IPAddress('10.0.0.2'), srv.getPort('eth0')!.getMAC(), 'eth0');
  srv.addStaticARP(new IPAddress('10.0.0.1'), cli.getPort('eth0')!.getMAC(), 'eth0');
  const scheduler = new VirtualTimeScheduler();
  cli.setScheduler(scheduler);
  srv.setScheduler(scheduler);
  return { cli, srv, cable, scheduler };
}

describe('tcpConnect() real async wait (PRD-TCP.md P2)', () => {
  it('a lost SYN is recovered — tcpConnect() waits and resolves to the established socket instead of failing instantly', async () => {
    const { cli, srv, cable, scheduler } = buildPair();
    srv.getTcpStack().listen(7005, { onAccept: () => {} });
    cable.setPacketLossRate(0.999);
    cable.setRng(lossOnceRng());

    const pending = cli.tcpConnect('10.0.0.2', 7005);
    let settled: unknown = 'not-settled';
    void pending.then((s) => { settled = s; });
    await Promise.resolve();
    expect(settled).toBe('not-settled'); // genuinely still waiting, not an instant null

    scheduler.advance(TCP_INITIAL_RTO_MS + 10);
    const socket = await pending;
    expect(socket).not.toBeNull();
    expect(socket!.state).toBe('established');
  });

  it('a fully-lossy link only resolves to null once every retry is exhausted — not instantly', async () => {
    const { cli, srv, cable, scheduler } = buildPair();
    srv.getTcpStack().listen(7006, { onAccept: () => {} });
    cable.setPacketLossRate(1);
    cable.setRng(alwaysLossyRng());

    const pending = cli.tcpConnect('10.0.0.2', 7006);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    scheduler.advance(worstCaseRetransmitWindowMs() + 100);
    const socket = await pending;
    expect(socket).toBeNull();
  });

  it('a normal loss-free connect still resolves to the established socket (regression)', async () => {
    const { cli, srv } = buildPair();
    srv.getTcpStack().listen(7007, { onAccept: () => {} });
    const socket = await cli.tcpConnect('10.0.0.2', 7007);
    expect(socket).not.toBeNull();
    expect(socket!.state).toBe('established');
  });

  it('connecting to a port with no listener still resolves to null via the immediate RST (regression)', async () => {
    const { cli, srv } = buildPair();
    void srv;
    const socket = await cli.tcpConnect('10.0.0.2', 9999);
    expect(socket).toBeNull();
  });
});
