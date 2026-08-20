/**
 * PRD-TCP.md P4 — `RttEstimator`'s RFC 6298 SRTT/RTTVAR math, tested in
 * isolation first (no TcpStack/network plumbing needed — this is pure
 * arithmetic), then an integration section proving Karn's algorithm is
 * actually applied when `TcpStack` wires samples in from a real socket's
 * unacked-segment queue.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RttEstimator, TCP_INITIAL_RTO_MS, TCP_MAX_RTO_MS } from '@/network/tcp/RttEstimator';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('RttEstimator (RFC 6298)', () => {
  it('before any sample, currentRto() is the fixed initial RTO', () => {
    const rtt = new RttEstimator();
    expect(rtt.currentRto()).toBe(TCP_INITIAL_RTO_MS);
  });

  it('backoff() doubles the RTO each time, capped at the maximum (RFC 6298 §5.5)', () => {
    const rtt = new RttEstimator();
    expect(rtt.backoff()).toBe(2000);
    expect(rtt.backoff()).toBe(4000);
    expect(rtt.backoff()).toBe(8000);
  });

  it('backoff() never exceeds the configured maximum RTO', () => {
    const rtt = new RttEstimator(1000, 5000);
    rtt.backoff(); // 2000
    rtt.backoff(); // 4000
    expect(rtt.backoff()).toBe(5000); // would be 8000 uncapped
    expect(rtt.backoff()).toBe(5000);
  });

  it('the first sample sets SRTT = R, RTTVAR = R/2 (RFC 6298 §2.2), then RTO = SRTT + 4×RTTVAR', () => {
    const rtt = new RttEstimator();
    rtt.sample(2000);
    // srtt=2000, rttvar=1000 -> rto = 2000 + max(1, 4*1000) = 6000
    expect(rtt.currentRto()).toBe(6000);
  });

  it('a second identical sample sharpens RTTVAR downward per the smoothing formula (RFC 6298 §2.3)', () => {
    const rtt = new RttEstimator();
    rtt.sample(2000); // srtt=2000, rttvar=1000, rto=6000
    rtt.sample(2000); // rttvar = 0.75*1000 + 0.25*|2000-2000| = 750; srtt stays 2000
    // rto = 2000 + 4*750 = 5000
    expect(rtt.currentRto()).toBe(5000);
  });

  it('a jittery sample widens RTTVAR and pulls SRTT toward the new value', () => {
    const rtt = new RttEstimator();
    rtt.sample(100); // srtt=100, rttvar=50
    rtt.sample(300); // rttvar = 0.75*50 + 0.25*|100-300| = 87.5; srtt = 0.875*100+0.125*300 = 125
    // rto = 125 + 4*87.5 = 475 -> floored to the 1s minimum (RFC 6298 §2.4)
    expect(rtt.currentRto()).toBe(TCP_INITIAL_RTO_MS);
  });

  it('never rounds the computed RTO below the 1-second floor (RFC 6298 §2.4), however small the samples are', () => {
    const rtt = new RttEstimator();
    rtt.sample(1);
    rtt.sample(1);
    rtt.sample(1);
    expect(rtt.currentRto()).toBe(TCP_INITIAL_RTO_MS);
  });

  it('caps the SRTT-derived RTO at the configured maximum, same as backoff()', () => {
    const rtt = new RttEstimator();
    rtt.sample(100_000); // srtt=100000, rttvar=50000 -> raw rto = 300000, way above the cap
    expect(rtt.currentRto()).toBe(TCP_MAX_RTO_MS);
  });

  it('backoff() after a sample doubles from the SRTT-based RTO, not from the fixed initial value', () => {
    const rtt = new RttEstimator();
    rtt.sample(2000); // rto=6000
    expect(rtt.backoff()).toBe(12000);
  });

  it('reset() after a sample drops back to the SRTT-based estimate, not the fixed initial value', () => {
    const rtt = new RttEstimator();
    rtt.sample(2000); // rto=6000
    rtt.backoff(); // 12000
    rtt.backoff(); // 24000
    rtt.reset();
    expect(rtt.currentRto()).toBe(6000);
  });

  it('reset() before any sample exists falls back to the fixed initial RTO', () => {
    const rtt = new RttEstimator();
    rtt.backoff(); // 2000, no sample taken
    rtt.reset();
    expect(rtt.currentRto()).toBe(TCP_INITIAL_RTO_MS);
  });
});

function lossOnceRng(): () => number {
  let calls = 0;
  return () => (calls++ === 0 ? 0 : 1);
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

describe('Karn\'s algorithm through TcpStack (PRD-TCP.md P4 integration)', () => {
  it('a retransmitted segment never feeds an RTT sample — its ambiguous elapsed time does not poison the estimator', () => {
    const { cli, srv, cable, scheduler } = buildPair();
    const received: unknown[] = [];
    srv.getTcpStack().listen(7200, { onAccept: (s) => { s.onData((d) => received.push(d)); } });
    const clientSocket = cli.getTcpStack().connect('10.0.0.2', 7200)!;

    cable.setPacketLossRate(0.999);
    cable.setRng(lossOnceRng());
    clientSocket.send('first');
    // Recovery takes a whole RTO cycle (~1s) — if that ambiguous, retry-
    // inclusive elapsed time were (wrongly) sampled, the estimator's RTO
    // would jump well above the fixed floor.
    scheduler.advance(TCP_INITIAL_RTO_MS + 10);
    expect(received).toEqual(['first']);
    expect(clientSocket.rtt.currentRto()).toBe(TCP_INITIAL_RTO_MS);

    // A subsequent clean (never-retransmitted) segment's genuinely tiny
    // elapsed time is Karn-eligible and does get sampled — still floors
    // to the 1-second minimum (RFC 6298 §2.4), which is the same value,
    // so the real proof is the *first* assertion above: had the lossy
    // segment's retry window been sampled, this would already have
    // drifted upward before the clean send ever happened.
    clientSocket.send('second');
    expect(received).toEqual(['first', 'second']);
    expect(clientSocket.rtt.currentRto()).toBe(TCP_INITIAL_RTO_MS);
  });
});
