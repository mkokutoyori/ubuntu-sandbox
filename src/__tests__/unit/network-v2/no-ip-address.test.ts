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

describe('no ip address', () => {
  it('removes the interface IP and its connected route', async () => {
    const r = new CiscoRouter('R', 0, 0);
    await run(r, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.5.5.1 255.255.255.0', 'no shutdown', 'exit', 'end']);
    expect(await r.executeCommand('show ip route')).toContain('10.5.5.0');

    await run(r, ['configure terminal', 'interface GigabitEthernet0/0', 'no ip address', 'exit', 'end']);
    expect(await r.executeCommand('show ip route')).not.toContain('10.5.5.0');
    expect(await r.executeCommand('show ip interface brief')).toMatch(/GigabitEthernet0\/0\s+unassigned/);
  });

  it('lets a subinterface reuse the physical interface former subnet (router-on-a-stick)', async () => {
    const r = new CiscoRouter('R', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 26, 100, 0);
    const h10 = new LinuxPC('linux-pc', 'H10', -100, 0);
    const h20 = new LinuxPC('linux-pc', 'H20', -100, 100);
    new Cable('up').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('a').connect(h10.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    new Cable('b').connect(h20.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);

    await run(r, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.1.1.1 255.255.255.0', 'no shutdown', 'exit', 'end']);
    await run(sw, ['enable', 'configure terminal', 'vlan 10', 'exit', 'vlan 20', 'exit',
      'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface FastEthernet0/3', 'switchport mode access', 'switchport access vlan 20', 'exit',
      'interface FastEthernet0/1', 'switchport trunk encapsulation dot1q', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'exit', 'end']);
    await run(r, ['configure terminal',
      'interface GigabitEthernet0/0', 'no ip address', 'exit',
      'interface GigabitEthernet0/0.10', 'encapsulation dot1Q 10', 'ip address 10.1.1.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/0.20', 'encapsulation dot1Q 20', 'ip address 10.1.20.1 255.255.255.0', 'no shutdown', 'exit', 'end']);
    await run(h10, ['ip link set eth0 up', 'ip addr add 10.1.1.10/24 dev eth0', 'ip route add default via 10.1.1.1']);
    await run(h20, ['ip link set eth0 up', 'ip addr add 10.1.20.20/24 dev eth0', 'ip route add default via 10.1.20.1']);

    expect(await r.executeCommand('show ip route')).toMatch(/10\.1\.1\.0\/24 is directly connected, GigabitEthernet0\/0\.10/);
    expect(await h10.executeCommand('ping -c 2 10.1.1.1')).toContain('0% packet loss');
    expect(await h10.executeCommand('ping -c 2 10.1.20.20')).toContain('0% packet loss');
  });
});
