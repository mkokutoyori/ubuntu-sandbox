import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

describe('Inter-VLAN routing (router-on-a-stick, 802.1Q subinterfaces)', () => {
  it('routes between two VLANs over a single dot1Q trunk', async () => {
    const r = new CiscoRouter('R', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 26, 100, 0);
    const h10 = new LinuxPC('linux-pc', 'H10', -100, 0);
    const h20 = new LinuxPC('linux-pc', 'H20', -100, 100);
    new Cable('up').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    new Cable('a').connect(h10.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
    new Cable('b').connect(h20.getPort('eth0')!, sw.getPort('FastEthernet0/4')!);

    await run(sw, ['enable', 'configure terminal',
      'vlan 10', 'exit', 'vlan 20', 'exit',
      'interface FastEthernet0/3', 'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface FastEthernet0/4', 'switchport mode access', 'switchport access vlan 20', 'exit',
      'interface FastEthernet0/2', 'switchport trunk encapsulation dot1q', 'switchport mode trunk',
      'switchport trunk allowed vlan 10,20', 'exit', 'end']);
    await run(r, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'no ip address', 'no shutdown', 'exit',
      'interface GigabitEthernet0/0.10', 'encapsulation dot1Q 10', 'ip address 10.1.10.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/0.20', 'encapsulation dot1Q 20', 'ip address 10.1.20.1 255.255.255.0', 'no shutdown', 'exit', 'end']);
    await run(h10, ['ip link set eth0 up', 'ip addr add 10.1.10.10/24 dev eth0', 'ip route add default via 10.1.10.1']);
    await run(h20, ['ip link set eth0 up', 'ip addr add 10.1.20.20/24 dev eth0', 'ip route add default via 10.1.20.1']);

    expect(await h10.executeCommand('ping -c 2 10.1.10.1')).toContain('0% packet loss');
    expect(await h20.executeCommand('ping -c 2 10.1.20.1')).toContain('0% packet loss');
    expect(await h10.executeCommand('ping -c 2 10.1.20.20')).toContain('0% packet loss');
    expect(await h20.executeCommand('ping -c 2 10.1.10.10')).toContain('0% packet loss');

    const arp = await r.executeCommand('show ip arp');
    expect(arp).toContain('GigabitEthernet0/0.10');
    expect(arp).toContain('GigabitEthernet0/0.20');
  });
});
