/**
 * firewall policy `tcp-mss-sender` / `tcp-mss-receiver`: the MSS option of the
 * SYN (sender) and of the SYN-ACK (receiver) is lowered to the configured
 * value in transit, and each end reads the clamped value in `ss -tin`.
 *
 * Measured on a git worktree of HEAD before the change: the grammar refuses
 * both attributes, so the 2 clamping cases fall (2 of 3); the unclamped witness passes
 * either way and proves the lab negotiates the full MSS (1448 with timestamps) without them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function run(d: { executeCommand(c: string): Promise<string> }, cmds: string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

async function lab(extra: string[]) {
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
    'config firewall policy', 'edit 1', 'set srcintf "port2"', 'set dstintf "port3"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept',
    ...extra, 'next', 'end',
  ]);
  srv.getTcpStack().listen(9000, { onAccept: () => undefined });
  pc.getTcpStack().connect('192.168.20.10', 9000);
  const mss = async (d: LinuxPC | LinuxServer) => {
    const out = await d.executeCommand('ss -tin');
    return Number.parseInt(/\bmss:(\d+)/.exec(out)?.[1] ?? 'NaN', 10);
  };
  return { clientMss: () => mss(pc), serverMss: () => mss(srv) };
}

describe('policy TCP MSS clamp', () => {
  it('witness: without it both ends negotiate the full MSS', async () => {
    const l = await lab([]);
    expect(await l.clientMss()).toBe(1448);
    expect(await l.serverMss()).toBe(1448);
  });

  it('tcp-mss-sender lowers the MSS the server learns from the SYN', async () => {
    const l = await lab(['set tcp-mss-sender 536']);
    expect(await l.serverMss()).toBe(524);
    expect(await l.clientMss()).toBe(1448);
  });

  it('tcp-mss-receiver lowers the MSS the client learns from the SYN-ACK', async () => {
    const l = await lab(['set tcp-mss-receiver 600']);
    expect(await l.clientMss()).toBe(588);
    expect(await l.serverMss()).toBe(1448);
  });
});
