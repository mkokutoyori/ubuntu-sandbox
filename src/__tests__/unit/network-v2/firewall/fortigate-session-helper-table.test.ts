/*
 * Probe — config system session-helper exists, ships the FortiOS factory
 * table, and DECIDES where the ftp helper listens.
 *
 * Before: "show system session-helper" answered "unknown configuration
 * path" and the ftp helper was hard-wired to TCP/21, so no entry could be
 * shown, removed or moved.
 *
 * Authority for the factory table: a real FortiGate "show
 * full-configuration" (FG100D, FortiOS 5.04 build 1064) published by
 * Microsoft in Azure/Azure-vpn-config-samples
 * (Fortinet/Current/fortigate_show full-configuration.txt), twenty entries,
 * ftp as entry 9. The accepted helper names come from the Fortinet Ansible
 * schema (fortios_system_session_helper).
 *
 * Measured before the change (git stash of src/network/devices/firewall):
 * 3 of the 6 cases fail.
 * Passing either way:
 *   - "a policy limited to service FTP downloads" is the WITNESS: vsftpd,
 *     curl and the helper were already sound on TCP/21.
 *   - "putting the ftp helper back restores the download" passes before
 *     because the helper was never removable; after, it proves re-adding
 *     an entry re-arms it.
 *   - "a helper name FortiOS does not know is refused" passes before
 *     because the whole path was refused.
 */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { type Cli, taper } from '../../new_firewall/fortigateBatteryHarness';

async function buildLab(): Promise<{ pc: LinuxPC; fw: Cli }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const srv = new LinuxServer('linux-server', 'ftp1', 0, 0);
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli;
  pc.powerOn();
  srv.powerOn();
  new Cable('lan').connect(pc.getPort('eth0') as never, fw.getPort('port1') as never);
  new Cable('wan').connect(fw.getPort('wan1') as never, srv.getPort('eth0') as never);
  await taper(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next',
    'end',
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"',
    'set dstaddr "all"', 'set action accept', 'set schedule "always"',
    'set service "FTP"', 'set nat enable', 'next',
    'end',
  ]);
  await taper(pc as unknown as Cli, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1']);
  await taper(srv as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0', 'ip route add default via 203.0.113.1',
    'apt install -y vsftpd', 'echo FTP_DATA > /srv/ftp/test.txt',
  ]);
  return { pc, fw };
}

describe('FortiGate config system session-helper', () => {
  it('a policy limited to service FTP downloads through the ftp helper', async () => {
    const { pc } = await buildLab();
    expect(await pc.executeCommand('curl -sS ftp://203.0.113.9/test.txt')).toBe('FTP_DATA\n');
  });

  it('the factory table lists the ftp helper as entry 9 on TCP/21', async () => {
    const { fw } = await buildLab();
    const shown = await fw.executeCommand('show system session-helper');
    expect(shown).toContain('    edit 9\n        set name ftp\n        set protocol 6\n        set port 21\n    next');
  });

  it('the factory table carries the twenty FortiOS entries', async () => {
    const { fw } = await buildLab();
    const shown = await fw.executeCommand('show system session-helper');
    expect(shown.match(/^ {4}edit \d+$/gm)).toHaveLength(20);
    expect(shown).toContain('    edit 20\n        set name mgcp\n        set protocol 17\n        set port 2727\n    next');
  });

  it('deleting the ftp entry stops the helper: the passive data connection is refused', async () => {
    const { pc, fw } = await buildLab();
    await taper(fw, ['config system session-helper', 'delete 9', 'end']);
    expect(await pc.executeCommand('curl -sS ftp://203.0.113.9/test.txt; echo EC=$?')).not.toContain('FTP_DATA');
  });

  it('putting the ftp helper back restores the download', async () => {
    const { pc, fw } = await buildLab();
    await taper(fw, [
      'config system session-helper', 'delete 9',
      'edit 21', 'set name ftp', 'set protocol 6', 'set port 21', 'next', 'end',
    ]);
    expect(await pc.executeCommand('curl -sS ftp://203.0.113.9/test.txt')).toBe('FTP_DATA\n');
  });

  it('a helper name FortiOS does not know is refused', async () => {
    const { fw } = await buildLab();
    await taper(fw, ['config system session-helper', 'edit 30']);
    expect(await fw.executeCommand('set name zorglub')).toMatch(/Command fail/);
  });
});
