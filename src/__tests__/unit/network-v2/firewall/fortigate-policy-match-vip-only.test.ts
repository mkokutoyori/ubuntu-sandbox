/**
 * firewall policy `set match-vip-only enable` on a deny policy: it matches
 * only packets whose destination a VIP has rewritten. Traffic that reaches the
 * same server on its real address falls through to the next policy.
 *
 * Measured on a git worktree of HEAD before the change: the grammar refuses
 * the attribute, so the deny policy stays a plain "deny everything from wan1"
 * and the 1 case that expects the direct flow to be served falls (1 of 3). The
 * two others are witnesses that pass either way: the VIP flow is denied by the
 * match-vip-only policy, and without the attribute the direct flow is denied.
  */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';

interface Cli { executeCommand(command: string): Promise<string> }

async function type(device: Cli, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function lab(vipOnly: boolean) {
  const lan = new LinuxServer('linux-server', 'LAN-Web', 0, 0);
  const wan = new LinuxServer('linux-server', 'WAN-Host', 0, 0);
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli & { getPort(name: string): unknown };
  lan.powerOn();
  wan.powerOn();
  new Cable('lan').connect(lan.getPort('eth0') as never, fw.getPort('port1') as never);
  new Cable('wan').connect(fw.getPort('wan1') as never, wan.getPort('eth0') as never);
  await type(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end',
    'config firewall vip', 'edit "VIP_WEB"', 'set extip 203.0.113.1', 'set mappedip "192.168.1.10"',
    'set portforward enable', 'set extport 80', 'set mappedport 80', 'next', 'end',
    'config firewall policy',
    'edit 1', 'set srcintf "wan1"', 'set dstintf "port1"', 'set srcaddr "all"',
    'set dstaddr "all"', 'set action deny', 'set schedule "always"', 'set service "HTTP"',
    ...(vipOnly ? ['set match-vip-only enable'] : []), 'next',
    'edit 2', 'set srcintf "wan1"', 'set dstintf "port1"', 'set srcaddr "all"',
    'set dstaddr "all"', 'set action accept', 'set schedule "always"', 'set service "HTTP"',
    'next', 'end',
  ]);
  await type(lan, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1', 'systemctl start nginx']);
  await type(wan, ['ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0',
    'ip route add default via 203.0.113.1']);
  return {
    viaVip: () => wan.executeCommand('curl -sS --connect-timeout 2 http://203.0.113.1/'),
    direct: () => wan.executeCommand('curl -sS --connect-timeout 2 http://192.168.1.10/'),
  };
}

describe('policy match-vip-only', () => {
  it('witness: the VIP flow is denied by the match-vip-only policy', async () => {
    expect(await (await lab(true)).viaVip()).not.toMatch(/nginx/i);
  });

  it('witness: without the attribute the direct flow is denied', async () => {
    expect(await (await lab(false)).direct()).not.toMatch(/nginx/i);
  });

  it('with the attribute the direct flow falls through to the next policy', async () => {
    expect(await (await lab(true)).direct()).toMatch(/nginx/i);
  });
});
