import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

describe('DHCP server identifier (Option 54)', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
  });

  it('advertises the serving gateway, not 0.0.0.0, and still completes DORA', async () => {
    const router = new CiscoRouter('DHCP-Server');
    const sw = new CiscoSwitch('switch-cisco', 'SW1');
    const pc = new LinuxPC('linux-pc', 'PC1');

    router.configureInterface('GigabitEthernet0/0', new IPAddress('192.168.50.1'), new SubnetMask('255.255.255.0'));
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    await router.executeCommand('ip dhcp pool LAN');
    await router.executeCommand('network 192.168.50.0 255.255.255.0');
    await router.executeCommand('default-router 192.168.50.1');
    await router.executeCommand('dns-server 192.168.50.1');
    await router.executeCommand('exit');
    await router.executeCommand('end');

    const c1 = new Cable('c1');
    c1.connect(router.getPort('GigabitEthernet0/0')!, sw.getPort('GigabitEthernet0/1')!);
    const c2 = new Cable('c2');
    c2.connect(sw.getPort('GigabitEthernet0/2')!, pc.getPort('eth0')!);

    const out = await pc.executeCommand('sudo dhclient -v -d eth0');
    expect(out).toContain('DHCPOFFER of 192.168.50.');
    expect(out).toContain('from 192.168.50.1');
    expect(out).not.toContain('from 0.0.0.0');
    expect(out).toContain('DHCPACK of 192.168.50.');

    const ip = await pc.executeCommand('ip addr show eth0');
    expect(ip).toContain('192.168.50.');
  });
});
