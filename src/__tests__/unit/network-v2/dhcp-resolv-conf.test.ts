import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

describe('DHCP populates /etc/resolv.conf', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
  });

  async function dora(): Promise<LinuxPC> {
    const router = new CiscoRouter('DHCP-Server');
    const sw = new CiscoSwitch('switch-cisco', 'SW1');
    const pc = new LinuxPC('linux-pc', 'PC1');

    router.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    await router.executeCommand('ip dhcp pool LAN');
    await router.executeCommand('network 192.168.1.0 255.255.255.0');
    await router.executeCommand('default-router 192.168.1.1');
    await router.executeCommand('dns-server 10.3.3.10 8.8.8.8');
    await router.executeCommand('domain-name acme.example');
    await router.executeCommand('exit');
    await router.executeCommand('end');

    const c1 = new Cable('c1');
    c1.connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('GigabitEthernet0/1')!);
    const c2 = new Cable('c2');
    c2.connect(sw.getPort('GigabitEthernet0/2')!, pc.getPort('eth0')!);

    await pc.executeCommand('sudo dhclient eth0');
    return pc;
  }

  it('writes nameserver and search entries after a lease', async () => {
    const pc = await dora();
    const out = await pc.executeCommand('cat /etc/resolv.conf');
    expect(out).not.toMatch(/No such file/);
    expect(out).toContain('nameserver 10.3.3.10');
    expect(out).toContain('nameserver 8.8.8.8');
    expect(out).toContain('search acme.example');
  });

  it('clears resolv.conf on lease release', async () => {
    const pc = await dora();
    await pc.executeCommand('sudo dhclient -r eth0');
    const out = await pc.executeCommand('cat /etc/resolv.conf');
    expect(out).not.toContain('nameserver 10.3.3.10');
  });
});
