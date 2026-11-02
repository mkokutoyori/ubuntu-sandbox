/**
 * A DHCPv4 lease contributes its name servers and search domain to /etc/resolv.conf; it does not own the file. Measured before the change: the lease rewrote the whole file (a static
 * `nameserver` line, or a server learned from a Router Advertisement, vanished at the first lease) and a release emptied it. Now the lease adds its entries through the same ResolvConfEdit that
 * the DHCPv6 and RDNSS paths use, remembers what it added per interface, and a renewal or release takes back only those.
 * Discriminated with git stash on src/network: 2 of 3 cases fall (the static line survives the lease; the release keeps it). The WITNESS passes either way: the lease entries appear on an empty file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

async function lab(): Promise<LinuxPC> {
  const router = new CiscoRouter('DHCP-Server');
  const sw = new CiscoSwitch('switch-cisco', 'SW1');
  const pc = new LinuxPC('linux-pc', 'PC1');
  router.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  for (const line of ['enable', 'configure terminal', 'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'dns-server 10.3.3.10', 'domain-name acme.example', 'exit', 'end']) {
    await router.executeCommand(line);
  }
  new Cable('c1').connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('GigabitEthernet0/1')!);
  new Cable('c2').connect(sw.getPort('GigabitEthernet0/2')!, pc.getPort('eth0')!);
  return pc;
}

describe('a DHCPv4 lease and /etc/resolv.conf', () => {
  it('WITNESS: the lease entries appear on an empty file', async () => {
    const pc = await lab();
    await pc.executeCommand('sudo dhclient eth0');
    expect(await pc.executeCommand('cat /etc/resolv.conf')).toBe('search acme.example\nnameserver 10.3.3.10');
  });

  it('keeps a static nameserver line', async () => {
    const pc = await lab();
    await pc.executeCommand("sudo sh -c 'echo nameserver 9.9.9.9 > /etc/resolv.conf'");
    await pc.executeCommand('sudo dhclient eth0');
    const file = await pc.executeCommand('cat /etc/resolv.conf');
    expect(file).toContain('nameserver 9.9.9.9');
    expect(file).toContain('nameserver 10.3.3.10');
  });

  it('takes back only its own entries on release', async () => {
    const pc = await lab();
    await pc.executeCommand("sudo sh -c 'echo nameserver 9.9.9.9 > /etc/resolv.conf'");
    await pc.executeCommand('sudo dhclient eth0');
    await pc.executeCommand('sudo dhclient -r eth0');
    expect(await pc.executeCommand('cat /etc/resolv.conf')).toBe('nameserver 9.9.9.9');
  });
});
