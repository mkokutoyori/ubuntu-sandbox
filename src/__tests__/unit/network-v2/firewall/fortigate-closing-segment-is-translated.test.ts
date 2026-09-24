/*
 * Probe — the segment that closes a NATed session (a RST) is translated
 * back like every other segment of that session.
 *
 * The session-lookup stage closed the session on a RST and let the packet
 * through WITHOUT re-applying the session's translation: a RST from the
 * real server kept its private address on the way out of a VIP, and a RST
 * to a SNATed client stayed addressed to the firewall's own public address.
 * Either way the client never recognised it and waited for its timeout.
 *
 * Measured before the fix (git stash of src/network): 2 of the 3 cases
 * fail, both with "curl: (28) … Timeout was reached" where a closed port
 * must answer "Connection refused".
 * Passing either way:
 *   - "a listening server behind a VIP" is the WITNESS: VIP, policy and
 *     routing are sound, so the refusals measure the closing segment only.
 */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';

interface Cli { executeCommand(command: string): Promise<string> }

async function type(device: Cli, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function buildLab(): Promise<{ lan: LinuxServer; wan: LinuxServer; fw: Cli }> {
  const lan = new LinuxServer('linux-server', 'LAN-Web', 0, 0);
  const wan = new LinuxServer('linux-server', 'WAN-Host', 0, 0);
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli & {
    getPort(name: string): unknown;
  };
  lan.powerOn();
  wan.powerOn();
  new Cable('lan').connect(lan.getPort('eth0') as never, fw.getPort('port1') as never);
  new Cable('wan').connect(fw.getPort('wan1') as never, wan.getPort('eth0') as never);
  await type(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next',
    'end',
    'config firewall vip',
    'edit "VIP_WEB"', 'set extip 203.0.113.1', 'set mappedip "192.168.1.10"',
    'set portforward enable', 'set extport 80', 'set mappedport 80', 'next',
    'end',
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"',
    'set dstaddr "all"', 'set action accept', 'set schedule "always"',
    'set service "ALL"', 'set nat enable', 'next',
    'edit 2', 'set srcintf "wan1"', 'set dstintf "port1"', 'set srcaddr "all"',
    'set dstaddr "VIP_WEB"', 'set action accept', 'set schedule "always"',
    'set service "HTTP"', 'next',
    'end',
  ]);
  await type(lan, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1']);
  await type(wan, ['ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0', 'ip route add default via 203.0.113.1']);
  return { lan, wan, fw };
}

describe('a closing segment is translated like the rest of its session', () => {
  it('a listening server behind a VIP serves the page', async () => {
    const { lan, wan } = await buildLab();
    await lan.executeCommand('systemctl start nginx');
    expect(await wan.executeCommand('curl -sS --connect-timeout 2 http://203.0.113.1/')).toMatch(/nginx/i);
  });

  it('a closed port behind a VIP is refused, not timed out', async () => {
    const { wan } = await buildLab();
    const out = await wan.executeCommand('curl -sS --connect-timeout 2 http://203.0.113.1/; echo EC=$?');
    expect(out).toContain('Connection refused');
    expect(out).toContain('EC=7');
  });

  it('a closed port reached through SNAT is refused, not timed out', async () => {
    const { lan } = await buildLab();
    const out = await lan.executeCommand('curl -sS --connect-timeout 2 http://203.0.113.9:81/; echo EC=$?');
    expect(out).toContain('Connection refused');
    expect(out).toContain('EC=7');
  });
});
