/**
 * firewall vip `set status disable`: a disabled VIP translates nothing and is
 * enabled again by `set status enable`.
 *
 * Measured on a git worktree of HEAD before the change: the grammar refuses
 * the attribute, so the VIP keeps translating and the 1 case that expects a
 * disabled VIP to stop serving falls (1 of 3). The enabled witness and the
 * re-enable case pass either way.
  */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';

interface Cli { executeCommand(command: string): Promise<string> }

async function type(device: Cli, lines: readonly string[]): Promise<string> {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out.join('\n');
}

async function lab(filter: string | null, extraVip: string[] = []) {
  const lan = new LinuxServer('linux-server', 'LAN-Web', 0, 0);
  const wan = new LinuxServer('linux-server', 'WAN-Host', 0, 0);
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli & { getPort(name: string): unknown };
  lan.powerOn();
  wan.powerOn();
  new Cable('lan').connect(lan.getPort('eth0') as never, fw.getPort('port1') as never);
  new Cable('wan').connect(fw.getPort('wan1') as never, wan.getPort('eth0') as never);
  const typed = await type(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end',
    'config firewall vip', 'edit "VIP_WEB"', 'set extip 203.0.113.1', 'set mappedip "192.168.1.10"',
    'set portforward enable', 'set extport 80', 'set mappedport 80',
    ...(filter === null ? [] : [`set src-filter ${filter}`]), ...extraVip, 'next', 'end',
    'config firewall policy',
    'edit 2', 'set srcintf "wan1"', 'set dstintf "port1"', 'set srcaddr "all"',
    'set dstaddr "VIP_WEB"', 'set action accept', 'set schedule "always"',
    'set service "HTTP"', 'next', 'end',
  ]);
  await type(lan, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1', 'systemctl start nginx']);
  await type(wan, ['ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0',
    'ip route add default via 203.0.113.1']);
  const reach = () => wan.executeCommand('curl -sS --connect-timeout 2 http://203.0.113.1/');
  return { typed, reach, fw };
}

describe('vip status', () => {
  it('witness: an enabled VIP serves the page', async () => {
    expect(await (await lab(null, ['set status enable'])).reach()).toMatch(/nginx/i);
  });

  it('a disabled VIP translates nothing', async () => {
    expect(await (await lab(null, ['set status disable'])).reach()).not.toMatch(/nginx/i);
  });

  it('enabling it again restores the translation', async () => {
    const l = await lab(null, ['set status disable']);
    for (const line of ['config firewall vip', 'edit "VIP_WEB"', 'set status enable', 'next', 'end']) {
      await l.fw.executeCommand(line);
    }
    expect(await l.reach()).toMatch(/nginx/i);
  });
});
