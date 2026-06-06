import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

describe('L3 switching — SVI / VLANIF inter-VLAN routing', () => {
  it('Cisco SVI routes between VLANs', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    const h10 = new LinuxPC('linux-pc', 'H10', -100, 0);
    const h20 = new LinuxPC('linux-pc', 'H20', -100, 100);
    new Cable('a').connect(h10.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    new Cable('b').connect(h20.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
    await run(sw, ['enable', 'configure terminal', 'ip routing', 'vlan 10', 'exit', 'vlan 20', 'exit',
      'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface FastEthernet0/3', 'switchport mode access', 'switchport access vlan 20', 'exit',
      'interface Vlan10', 'ip address 10.1.10.1 255.255.255.0', 'no shutdown', 'exit',
      'interface Vlan20', 'ip address 10.1.20.1 255.255.255.0', 'no shutdown', 'exit', 'end']);
    await run(h10, ['ip link set eth0 up', 'ip addr add 10.1.10.10/24 dev eth0', 'ip route add default via 10.1.10.1']);
    await run(h20, ['ip link set eth0 up', 'ip addr add 10.1.20.20/24 dev eth0', 'ip route add default via 10.1.20.1']);
    expect(await h10.executeCommand('ping -c 2 10.1.10.1')).toContain('0% packet loss');
    expect(await h10.executeCommand('ping -c 2 10.1.20.20')).toContain('0% packet loss');
    expect(await h20.executeCommand('ping -c 2 10.1.10.10')).toContain('0% packet loss');
  });

  it('Huawei VLANIF routes between VLANs (dotted and prefix masks)', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW', 24);
    const h10 = new LinuxPC('linux-pc', 'H10', -100, 0);
    const h20 = new LinuxPC('linux-pc', 'H20', -100, 100);
    new Cable('a').connect(h10.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/2')!);
    new Cable('b').connect(h20.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/3')!);
    await run(sw, ['system-view', 'vlan batch 10 20',
      'interface GigabitEthernet0/0/2', 'port link-type access', 'port default vlan 10', 'quit',
      'interface GigabitEthernet0/0/3', 'port link-type access', 'port default vlan 20', 'quit',
      'interface Vlanif10', 'ip address 10.1.10.1 255.255.255.0', 'quit',
      'interface Vlanif20', 'ip address 10.1.20.1 24', 'quit', 'quit']);
    await run(h10, ['ip link set eth0 up', 'ip addr add 10.1.10.10/24 dev eth0', 'ip route add default via 10.1.10.1']);
    await run(h20, ['ip link set eth0 up', 'ip addr add 10.1.20.20/24 dev eth0', 'ip route add default via 10.1.20.1']);
    expect(await h10.executeCommand('ping -c 2 10.1.20.20')).toContain('0% packet loss');
    expect(await sw.executeCommand('display ip interface brief')).toContain('Vlanif10');
  });
});
