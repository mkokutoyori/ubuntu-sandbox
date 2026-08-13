import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { PingResult } from '@/network/devices/EndHost';
import { formatPingReplyLine } from '@/network/devices/linux/LinuxFormatHelpers';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function topo(): { a: LinuxPC; b: LinuxPC; cable: Cable } {
  const a = new LinuxPC('linux-pc', 'PC1');
  const b = new LinuxPC('linux-pc', 'PC2');
  a.configureInterface('eth0', new IPAddress('10.0.9.1'), new SubnetMask('255.255.255.0'));
  b.configureInterface('eth0', new IPAddress('10.0.9.2'), new SubnetMask('255.255.255.0'));
  const cable = new Cable('c1');
  cable.connect(a.getPort('eth0')!, b.getPort('eth0')!);
  return { a, b, cable };
}

describe('non-interactive ping on a severed link (docs/PRD-Link-State.md §4 #5, P3)', () => {
  it('renders a per-packet unreachable line, not just a silent summary', async () => {
    const { a, cable } = topo();
    await pingOnSimulatedClock(a, 'ping -c 1 10.0.9.2');
    cable.disconnect();

    const out = await pingOnSimulatedClock(a, 'ping -c 2 -W 1 10.0.9.2');
    expect(out).toContain('Destination Host Unreachable');
    expect(out).toContain('icmp_seq=1');
    expect(out).toContain('100% packet loss');
  }, 30000);

  it('still reports success while the cable is plugged in', async () => {
    const { a } = topo();
    const out = await pingOnSimulatedClock(a, 'ping -c 2 10.0.9.2');
    expect(out).toContain('0% packet loss');
    expect(out).not.toContain('Destination Host Unreachable');
  }, 30000);
});

describe('interactive/streaming ping across a mid-stream unplug (docs/PRD-Link-State.md §4 #6, P3)', () => {
  it('every packet after the unplug produces a visible line', async () => {
    const { a, cable } = topo();
    const results: PingResult[] = [];
    let n = 0;
    await a.pingStreamInSession('10.0.9.2', {
      count: 5,
      timeoutMs: 300,
      intervalMs: 0,
      onResult: (r) => { results.push(r); if (++n === 2) cable.disconnect(); },
      shouldStop: () => false,
      sleep: async () => {},
    });

    expect(results).toHaveLength(5);
    const after = results.slice(2);
    expect(after.every((r) => !r.success)).toBe(true);
    for (const r of after) {
      expect(formatPingReplyLine(r, 56)).not.toBeNull();
      expect(formatPingReplyLine(r, 56)).toContain('Destination Host Unreachable');
    }
  }, 30000);

  it('the successful packets before the unplug still render normally', async () => {
    const { a, cable } = topo();
    const results: PingResult[] = [];
    let n = 0;
    await a.pingStreamInSession('10.0.9.2', {
      count: 4,
      timeoutMs: 300,
      intervalMs: 0,
      onResult: (r) => { results.push(r); if (++n === 2) cable.disconnect(); },
      shouldStop: () => false,
      sleep: async () => {},
    });
    expect(results[0].success).toBe(true);
    expect(formatPingReplyLine(results[0], 56)).toContain('bytes from 10.0.9.2');
  }, 30000);
});

describe('a dropped packet is reported, not swallowed', () => {
  // This used to assert silence, matching Linux ping's own habit of
  // printing nothing for a timeout. That silence is what made a pulled
  // cable look like a frozen terminal: replies stop, nothing explains
  // why, and only the summary hints at it. Every probe now says what
  // happened to it, and a timeout is distinguished from the ICMP error
  // an unreachable local link produces.
  it('a plain timeout names the sequence it lost', () => {
    const r: PingResult = { success: false, rttMs: 0, ttl: 0, seq: 1, bytes: 0, fromIP: '', error: 'timeout' };
    expect(formatPingReplyLine(r, 56)).toBe('Request timeout for icmp_seq 1');
  });

  it('an unreachable local link still reports the ICMP error instead', () => {
    const r: PingResult = {
      success: false, rttMs: 0, ttl: 0, seq: 2, bytes: 0, fromIP: '',
      error: 'Destination unreachable from 10.0.9.1',
    };
    expect(formatPingReplyLine(r, 56)).toBe('From 10.0.9.1 icmp_seq=2 Destination Host Unreachable');
  });
});
