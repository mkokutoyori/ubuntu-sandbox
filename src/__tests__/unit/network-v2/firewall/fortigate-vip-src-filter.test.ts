/**
 * firewall vip `set src-filter <ip/mask | first-last>...`: the VIP only
 * translates traffic whose source is inside one of the listed ranges. The
 * reference spells the attribute `src-filter` and gives it literal ranges;
 * the simulator used to know a `srcfilter` that took address object names, a
 * name FortiOS does not have.
 *
 * Measured on a git worktree of HEAD before the change: 1 of 4 falls (the
 * filter that excludes the client). The 3 others pass either way: the
 * unfiltered witness proves the lab translates; the filter holding the client
 * passes because the refused `set` leaves the VIP unfiltered, so it serves for
 * the opposite reason; and the malformed range is refused whenever the
 * attribute is unknown or validates its values.
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

async function lab(filter: string | null) {
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
    ...(filter === null ? [] : [`set src-filter ${filter}`]), 'next', 'end',
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
  return { typed, reach };
}

describe('vip src-filter', () => {
  it('witness: without a filter the VIP serves the page', async () => {
    expect(await (await lab(null)).reach()).toMatch(/nginx/i);
  });

  it('a filter holding the client range still serves the page', async () => {
    const l = await lab('"198.51.100.0/24" "203.0.113.5-203.0.113.20"');
    expect(await l.reach()).toMatch(/nginx/i);
  });

  it('a filter that excludes the client range stops the translation', async () => {
    const l = await lab('"198.51.100.0/24"');
    expect(await l.reach()).not.toMatch(/nginx/i);
  });

  it('witness: a malformed range is refused', async () => {
    const l = await lab('"not-a-range"');
    expect(l.typed).toMatch(/fail|invalid|not/i);
  });
});
