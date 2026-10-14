/**
 * firewall policy `set send-deny-packet enable`: a denied TCP SYN is answered
 * with a RST (built by the one TCP reset constructor), a denied UDP datagram
 * with an ICMP port unreachable, and a policy without the flag stays silent.
 *
 * Measured on a git worktree of HEAD before the change: 2 of 4 cases fall
 * (the RST and the ICMP unreachable). The 2 witnesses pass either way: the
 * policy without the flag stays silent on TCP and on UDP, and the UDP one
 * proves the wire tap sees the datagram, so its zero is not vacuous.
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

async function run(d: { executeCommand(c: string): Promise<string> }, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

async function receivedUnreachables(pc: LinuxPC): Promise<number> {
  const stats = await pc.executeCommand('netstat -s');
  const match = /destination unreachable: (\d+)/.exec(stats);
  return match ? Number.parseInt(match[1], 10) : 0;
}

async function lab(sendDeny: boolean) {
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
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action deny',
    ...(sendDeny ? ['set send-deny-packet enable'] : []), 'next', 'end',
  ]);
  return { pc };
}

describe('send-deny-packet', () => {
  it('answers a denied SYN with a RST', async () => {
    const { pc } = await lab(true);
    const out = await pc.executeCommand('sudo hping3 -S -p 80 -c 1 192.168.20.10');
    expect(out).toContain('1 packets transmitted, 1 packets received, 0% packet loss');
    expect(out).toMatch(/flags=RA/);
  });

  it('answers a denied UDP datagram with an ICMP port unreachable the client counts', async () => {
    const { pc } = await lab(true);
    const before = await receivedUnreachables(pc);
    await pc.executeCommand('sudo hping3 --udp -p 5000 -c 1 192.168.20.10');
    expect(await receivedUnreachables(pc)).toBe(before + 1);
  });

  it('witness: without the flag the client counts none', async () => {
    const { pc } = await lab(false);
    const before = await receivedUnreachables(pc);
    await pc.executeCommand('sudo hping3 --udp -p 5000 -c 1 192.168.20.10');
    expect(await receivedUnreachables(pc)).toBe(before);
  });

  it('witness: a deny policy without the flag stays silent', async () => {
    const { pc } = await lab(false);
    const out = await pc.executeCommand('sudo hping3 -S -p 80 -c 1 192.168.20.10');
    expect(out).toContain('1 packets transmitted, 0 packets received, 100% packet loss');
  });
});
