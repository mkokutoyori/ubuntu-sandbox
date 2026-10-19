/**
 * firewall shaper per-ip-shaper and the policy's per-ip-shaper: one bucket per
 * client IP (max-bandwidth), a ceiling on the sessions each client IP may
 * hold (max-concurrent-session, -tcp-, -udp-), and forward / reverse DSCP.
 *
 * Measured on a git worktree of HEAD before the change: the table does not
 * exist, so the 4 cases that rely on it fall (4 of 5). The unshaped witness
 * (two connections both established) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function run(d: { executeCommand(c: string): Promise<string> }, cmds: string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

async function lab(shaper: string[]) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srv.getPort('eth0')!);
  await run(pc, ['ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1']);
  await run(srv, ['ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1']);
  await run(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'next',
    'edit port3', 'set mode static', 'set ip 192.168.20.1 255.255.255.0', 'next', 'end',
    ...(shaper.length === 0 ? [] : ['config firewall shaper per-ip-shaper', 'edit "per-client"', ...shaper, 'next', 'end']),
    'config firewall policy', 'edit 1', 'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept',
    ...(shaper.length === 0 ? [] : ['set per-ip-shaper "per-client"']), 'next', 'end',
  ]);
  srv.getTcpStack().listen(9000, { onAccept: () => undefined });
  srv.getTcpStack().listen(9001, { onAccept: () => undefined });
  const established = async () =>
    ((await pc.executeCommand('ss -tn')).match(/ESTAB/g) ?? []).length;
  return { fgt, pc, established,
    open: () => { pc.getTcpStack().connect('192.168.20.10', 9000); pc.getTcpStack().connect('192.168.20.10', 9001); } };
}

describe('per-IP shaper', () => {
  it('witness: without a limit both connections are established', async () => {
    const l = await lab([]);
    l.open();
    expect(await l.established()).toBe(2);
  });

  it('max-concurrent-session holds a client IP to its ceiling', async () => {
    const l = await lab(['set max-concurrent-session 1']);
    l.open();
    expect(await l.established()).toBe(1);
  });

  it('max-concurrent-tcp-session holds a client IP to its TCP ceiling', async () => {
    const l = await lab(['set max-concurrent-tcp-session 1']);
    l.open();
    expect(await l.established()).toBe(1);
  });

  it('max-bandwidth meters each client IP on its own bucket', async () => {
    const l = await lab(['set max-bandwidth 400']);
    const out = await pingOnSimulatedClock(l.pc, 'ping -c 10 -s 1400 192.168.20.10');
    const got = Number.parseInt(/(\d+) received/.exec(out)?.[1] ?? '-1', 10);
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThan(10);
  });

  it('diffserv-forward marks the original direction', async () => {
    const l = await lab(['set diffserv-forward enable', 'set diffservcode-forward 101110']);
    await pingOnSimulatedClock(l.pc, 'ping -c 1 192.168.20.10');
    const dump = await l.fgt.executeCommand('diagnose sniffer packet port3 "icmp" 6 4');
    expect(/0800 45b8/.test(dump)).toBe(true);
  });
});
