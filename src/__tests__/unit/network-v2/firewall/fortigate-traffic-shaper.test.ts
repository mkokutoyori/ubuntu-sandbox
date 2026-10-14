/**
 * firewall shaper traffic-shaper and the policy's traffic-shaper /
 * traffic-shaper-reverse: the shaper meters the packets of its policy on a
 * token bucket (qos/CarPolicer), drops what exceeds maximum-bandwidth, marks
 * DSCP statically or by band, and keeps one bucket per policy when per-policy
 * is on. The reverse shaper meters the reply direction.
 *
 * Measured on a git worktree of HEAD before the change: the table refused
 * every attribute, so 4 of 6 cases fall (maximum-bandwidth, the reverse
 * shaper, the DSCP marking, and the reason given for priority). The 2 others
 * pass either way: the unshaped flow loses nothing, and "the bandwidth-unit
 * scales the limit" passes because the refused shaper leaves the flow
 * unshaped, so it holds for the opposite reason and only the drop cases
 * prove the bucket. Priority and the VLAN CoS family stay refused, each with
 * the missing brick named (a congested egress queue shared between shapers,
 * a 802.1p field on the frames).
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

async function run(d: { executeCommand(c: string): Promise<string> }, cmds: string[]): Promise<string> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out.join('\n');
}

async function lab(shaper: string[], policy: string[]) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srv.getPort('eth0')!);
  await run(pc, ['ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1']);
  await run(srv, ['ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1']);
  const typed = await run(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'next',
    'edit port3', 'set mode static', 'set ip 192.168.20.1 255.255.255.0', 'next', 'end',
    ...(shaper.length === 0 ? [] : ['config firewall shaper traffic-shaper', 'edit "limit"', ...shaper, 'next', 'end']),
    'config firewall policy', 'edit 1', 'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept',
    ...policy, 'next', 'end',
  ]);
  const received = async (count = 10) => {
    const out = await pingOnSimulatedClock(pc, `ping -c ${count} -s 1400 192.168.20.10`);
    return Number.parseInt(/(\d+) received/.exec(out)?.[1] ?? '-1', 10);
  };
  return { fgt, pc, typed, received };
}

describe('traffic shaper', () => {
  it('witness: an unshaped flow loses nothing', async () => {
    expect(await (await lab([], [])).received()).toBe(10);
  });

  it('maximum-bandwidth drops what the bucket cannot carry', async () => {
    const l = await lab(['set maximum-bandwidth 160'], ['set traffic-shaper "limit"']);
    const got = await l.received();
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThan(10);
  });

  it('traffic-shaper-reverse meters the reply direction', async () => {
    const l = await lab(['set maximum-bandwidth 160'], ['set traffic-shaper-reverse "limit"']);
    const got = await l.received();
    expect(got).toBeLessThan(10);
  });

  it('the bandwidth-unit scales the limit', async () => {
    const l = await lab(['set maximum-bandwidth 100', 'set bandwidth-unit mbps'], ['set traffic-shaper "limit"']);
    expect(await l.received()).toBe(10);
  });

  it('a diffserv shaper marks the DSCP of what it accepts', async () => {
    const l = await lab(['set diffserv enable', 'set diffservcode 101110'], ['set traffic-shaper "limit"']);
    await pingOnSimulatedClock(l.pc, 'ping -c 1 192.168.20.10');
    const dump = await l.fgt.executeCommand('diagnose sniffer packet port3 "icmp" 6 4');
    expect(/0800 45b8/.test(dump)).toBe(true);
  });

  it('witness: priority is refused with the reason, not stored', async () => {
    const l = await lab(['set priority high'], []);
    expect(l.typed).toMatch(/queue/i);
  });
});
