/**
 * IPv4 host model (RFC 1122 §3.3.4.2) and loopback delivery.
 *
 * Before this fix, end hosts only accepted packets addressed to the IP of
 * the ingress interface — so a multi-homed Linux PC never answered pings
 * sent to its other interface (real Linux uses the weak host model), and
 * `ping 127.0.0.1` failed entirely (no loopback handling).
 *
 * Windows (Vista+) uses the strong host model on IPv4 and must keep
 * rejecting cross-interface delivery.
 *
 * Topology:
 *   PC1 (192.168.1.10/24, gw .1) ── eth0 GW (192.168.1.1/24)
 *                                   eth1 GW (10.0.0.1/24, not cabled)
 *   GW is a LinuxPC or a WindowsPC depending on the test; IP forwarding stays
 *   disabled so only local delivery can answer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function buildMultiHomedTopology(gwType: 'linux' | 'windows') {
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const gw = gwType === 'linux'
    ? new LinuxPC('linux-pc', 'GW')
    : new WindowsPC('windows-pc', 'GW');

  new Cable('pc1-gw').connect(pc1.getPort('eth0')!, gw.getPort('eth0')!);

  pc1.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
  pc1.setDefaultGateway(new IPAddress('192.168.1.1'));

  gw.configureInterface('eth0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  gw.configureInterface('eth1', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));

  return { pc1, gw };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('IPAddress.isLoopback (127.0.0.0/8)', () => {
  it('accepts the whole loopback block and rejects its neighbours', () => {
    expect(new IPAddress('127.0.0.1').isLoopback()).toBe(true);
    expect(new IPAddress('127.0.0.0').isLoopback()).toBe(true);
    expect(new IPAddress('127.255.255.255').isLoopback()).toBe(true);
    expect(new IPAddress('126.255.255.255').isLoopback()).toBe(false);
    expect(new IPAddress('128.0.0.0').isLoopback()).toBe(false);
  });
});

describe('Weak host model on Linux (RFC 1122 §3.3.4.2)', () => {
  it('answers a ping addressed to another local interface', async () => {
    const { pc1 } = buildMultiHomedTopology('linux');

    const out = await pc1.executeCommand('ping -c 1 10.0.0.1');

    // Reply must be sourced from the address the request was sent to
    // (RFC 1122 §3.2.2.6), not from the ingress interface address.
    expect(out).toContain('from 10.0.0.1');
    expect(out).toContain('0% packet loss');
  }, 15000);

  it('still answers a ping to the ingress interface address', async () => {
    const { pc1 } = buildMultiHomedTopology('linux');

    const out = await pc1.executeCommand('ping -c 1 192.168.1.1');

    expect(out).toContain('0% packet loss');
  }, 15000);
});

describe('Strong host model on Windows (Vista+ default)', () => {
  it('does NOT answer a ping addressed to another local interface', async () => {
    const { pc1 } = buildMultiHomedTopology('windows');

    const out = await pc1.executeCommand('ping -c 1 10.0.0.1');

    expect(out).toContain('100% packet loss');
  }, 15000);

  it('answers a ping to the ingress interface address', async () => {
    const { pc1 } = buildMultiHomedTopology('windows');

    const out = await pc1.executeCommand('ping -c 1 192.168.1.1');

    expect(out).toContain('0% packet loss');
  }, 15000);
});

describe('Loopback delivery (RFC 1122 §3.2.1.3)', () => {
  it('Linux: ping 127.0.0.1 succeeds without touching the wire', async () => {
    const pc = new LinuxPC('linux-pc', 'Solo');
    // No interface configured, no cable: loopback must still answer.
    const out = await pc.executeCommand('ping -c 2 127.0.0.1');

    expect(out).toContain('from 127.0.0.1');
    expect(out).toContain('0% packet loss');
  }, 15000);

  it('Linux: any 127/8 address answers (e.g. 127.0.0.53)', async () => {
    const pc = new LinuxPC('linux-pc', 'Solo');
    const out = await pc.executeCommand('ping -c 1 127.0.0.53');

    expect(out).toContain('0% packet loss');
  }, 15000);

  it('Windows: ping 127.0.0.1 succeeds', async () => {
    const pc = new WindowsPC('windows-pc', 'WinSolo');
    const out = await pc.executeCommand('ping 127.0.0.1');

    expect(out).toMatch(/Reply from 127\.0\.0\.1|\(0% loss\)/);
  }, 15000);

  it('Linux: self-ping of an owned address still succeeds', async () => {
    const { pc1 } = buildMultiHomedTopology('linux');
    const out = await pc1.executeCommand('ping -c 1 192.168.1.10');

    expect(out).toContain('0% packet loss');
  }, 15000);
});
