/*
 * Probe: `execute traceroute` printed `traceroute to A (A), 32 hops max, 84 byte packets`. Both captures ntc-templates keeps for
 * `fortinet_execute_traceroute` (a real FortiGate) carry the probe count in that line:
 * `traceroute to 8.8.8.8 (8.8.8.8), 32 hops max, 3 probe packets per hop, 84 byte packets`. The header now states the number of
 * probes per hop the unit really sends. The IPv6 form (`execute traceroute6`) has no capture here and keeps its header.
 * Discriminated with git stash on src/network: 1 of 3 falls before the change; the hop-line case and the IPv6 case pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function lab() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  new Cable('c').connect(pc.getPort('eth0')!, fgt.getPort('port1')!);
  for (const line of ['config system interface', 'edit port1', 'set mode static', 'set ip 10.0.0.1 255.255.255.0', 'next', 'end']) await fgt.executeCommand(line);
  for (const line of ['ip addr add 10.0.0.10/24 dev eth0', 'ip link set eth0 up']) await pc.executeCommand(line);
  return fgt;
}

describe('execute traceroute header', () => {
  it('states the probes per hop, as the captures do', async () => {
    const out = await (await lab()).executeCommand('execute traceroute 10.0.0.10');
    expect(out.split('\n')[0]).toBe('traceroute to 10.0.0.10 (10.0.0.10), 32 hops max, 3 probe packets per hop, 84 byte packets');
  });

  it('keeps one line per hop with three probe times', async () => {
    const out = await (await lab()).executeCommand('execute traceroute 10.0.0.10');
    expect(out.split('\n')[1]).toMatch(/^ 1  10\.0\.0\.10  [\d.]+ ms  [\d.]+ ms  [\d.]+ ms$/);
  });

  it('leaves the IPv6 header as it was', async () => {
    const fgt = await lab();
    const out = await fgt.executeCommand('execute traceroute6 2001:db8::10');
    expect(out).not.toContain('probe packets per hop');
  });
});
