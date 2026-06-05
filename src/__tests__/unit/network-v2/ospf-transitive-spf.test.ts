import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Configurable { executeCommand(cmd: string): Promise<string> }
const cfg = (d: Configurable, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

describe('OSPF — transitive SPF after later neighbours appear', () => {
  it('the first-configured router learns 2-hop routes once peers come up', async () => {
    const r1 = new CiscoRouter('R1', 0, 0);
    const r2 = new CiscoRouter('R2', 200, 0);
    const r3 = new CiscoRouter('R3', 400, 0);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/2')!, r3.getPort('GigabitEthernet0/1')!);

    await cfg(r1, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.12.12.1 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'router-id 1.1.1.1',
      'network 10.0.1.0 0.0.0.255 area 0', 'network 10.12.12.0 0.0.0.3 area 0', 'end',
    ]);
    await cfg(r2, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/1', 'ip address 10.12.12.2 255.255.255.252', 'no shutdown', 'exit',
      'interface GigabitEthernet0/2', 'ip address 10.23.23.2 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'router-id 2.2.2.2',
      'network 10.12.12.0 0.0.0.3 area 0', 'network 10.23.23.0 0.0.0.3 area 0', 'end',
    ]);
    await cfg(r3, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.3.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.23.23.3 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'router-id 3.3.3.3',
      'network 10.0.3.0 0.0.0.255 area 0', 'network 10.23.23.0 0.0.0.3 area 0', 'end',
    ]);

    const r1routes = await r1.executeCommand('show ip route ospf');
    const r3routes = await r3.executeCommand('show ip route ospf');

    expect(r1routes).toContain('10.23.23.0');
    expect(r1routes).toContain('10.0.3.0');
    expect(r3routes).toContain('10.12.12.0');
    expect(r3routes).toContain('10.0.1.0');
  });

  it('a spoke learns the other spoke LAN through a cross-vendor hub', async () => {
    const hub = new CiscoRouter('HUB', 0, 0);
    const spokeA = new CiscoRouter('SPOKE-A', 200, 0);
    const spokeB = new HuaweiRouter('SPOKE-B', 400, 0);
    new Cable('a').connect(hub.getPort('GigabitEthernet0/1')!, spokeA.getPort('GigabitEthernet0/1')!);
    new Cable('b').connect(hub.getPort('GigabitEthernet0/2')!, spokeB.getPort('GE0/0/1')!);

    await cfg(spokeA, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.10.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'router-id 10.10.10.10',
      'network 10.0.10.0 0.0.0.255 area 0', 'network 10.0.0.0 0.0.0.3 area 0', 'end',
    ]);
    await cfg(hub, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/1', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit',
      'interface GigabitEthernet0/2', 'ip address 10.0.0.5 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'router-id 100.100.100.100',
      'network 10.0.0.0 0.0.0.3 area 0', 'network 10.0.0.4 0.0.0.3 area 0', 'end',
    ]);
    await cfg(spokeB, [
      'system-view', 'sysname SPOKE-B',
      'interface GigabitEthernet0/0/0', 'ip address 10.0.20.1 255.255.255.0', 'undo shutdown', 'quit',
      'interface GigabitEthernet0/0/1', 'ip address 10.0.0.6 255.255.255.252', 'undo shutdown', 'quit',
      'ospf 1 router-id 20.20.20.20',
      'area 0', 'network 10.0.20.0 0.0.0.255', 'network 10.0.0.4 0.0.0.3', 'quit', 'quit', 'quit',
    ]);

    const aRoutes = await spokeA.executeCommand('show ip route ospf');
    expect(aRoutes).toContain('10.0.20.0');
  });
});
