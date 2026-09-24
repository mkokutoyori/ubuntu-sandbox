/*
 * Probe — a FortiGate policy limited to service FTP carries the passive
 * data connection that the control channel announced, and nothing else.
 *
 * A real FortiGate ships an `ftp` session helper (protocol 6, port 21)
 * that reads PASV/EPSV replies on the control session and admits the data
 * connection they announce under the same policy, NAT included. The
 * simulator had the machinery (SessionTable.installPinhole, parent/child
 * sessions closed together) and nothing that used it: the data connection
 * met the policy as a stranger and was dropped.
 *
 * Measured before the change (git stash of src/network): 1 of the 3 cases
 * fails — "service FTP alone" downloads nothing.
 * Passing either way:
 *   - "service ALL" is the WITNESS: vsftpd, curl ftp:// and routing are
 *     sound.
 *   - "an unannounced high port stays closed" is non-regression: the
 *     helper admits the announced connection only.
 */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import '../../new_firewall/fortigateBatteryHarness';

interface Cli { executeCommand(command: string): Promise<string> }

async function type(device: Cli, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function buildLab(service: string): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const srv = new LinuxServer('linux-server', 'ftp1', 0, 0);
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli & { getPort(name: string): unknown };
  pc.powerOn();
  srv.powerOn();
  new Cable('lan').connect(pc.getPort('eth0') as never, fw.getPort('port1') as never);
  new Cable('wan').connect(fw.getPort('wan1') as never, srv.getPort('eth0') as never);
  await type(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next',
    'end',
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"',
    'set dstaddr "all"', 'set action accept', 'set schedule "always"',
    `set service "${service}"`, 'set nat enable', 'next',
    'end',
  ]);
  await type(pc, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1']);
  await type(srv, [
    'ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0', 'ip route add default via 203.0.113.1',
    'apt install -y vsftpd', 'echo FTP_DATA > /srv/ftp/test.txt',
  ]);
  return { pc, srv };
}

describe('FortiGate ftp session helper', () => {
  it('service ALL downloads through the firewall', async () => {
    const { pc } = await buildLab('ALL');
    expect(await pc.executeCommand('curl -sS ftp://203.0.113.9/test.txt')).toBe('FTP_DATA\n');
  });

  it('service FTP alone carries the announced passive data connection', async () => {
    const { pc } = await buildLab('FTP');
    expect(await pc.executeCommand('curl -sS ftp://203.0.113.9/test.txt')).toBe('FTP_DATA\n');
  });

  it('an unannounced high port stays closed under service FTP', async () => {
    const { pc } = await buildLab('FTP');
    await pc.executeCommand('curl -sS ftp://203.0.113.9/test.txt');
    expect(await pc.executeCommand('nc -zv -w 1 203.0.113.9 40000')).not.toContain('succeeded');
  });
});
