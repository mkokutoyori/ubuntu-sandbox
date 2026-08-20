import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

const settle = () => new Promise((r) => setTimeout(r, 200));

interface Configurable { executeCommand(cmd: string): Promise<string> }
const cfg = async (d: Configurable, cmds: string[]) => {
  for (const c of cmds) await d.executeCommand(c);
};

async function triangle() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 200, 0);
  const r3 = new CiscoRouter('R3', 100, 200);

  const c13 = new Cable('c13');
  c13.connect(r1.getPort('GigabitEthernet0/2')!, r3.getPort('GigabitEthernet0/1')!);
  new Cable('c12').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('c23').connect(r2.getPort('GigabitEthernet0/2')!, r3.getPort('GigabitEthernet0/2')!);

  await cfg(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', 'ip address 10.0.12.1 255.255.255.252', 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'ip address 10.0.13.1 255.255.255.252', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 1.1.1.1',
    'network 10.0.12.0 0.0.0.3 area 0', 'network 10.0.13.0 0.0.0.3 area 0', 'end',
  ]);
  await cfg(r2, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', 'ip address 10.0.12.2 255.255.255.252', 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'ip address 10.0.23.1 255.255.255.252', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 2.2.2.2',
    'network 10.0.12.0 0.0.0.3 area 0', 'network 10.0.23.0 0.0.0.3 area 0', 'end',
  ]);
  await cfg(r3, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.3.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.13.2 255.255.255.252', 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'ip address 10.0.23.2 255.255.255.252', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 3.3.3.3',
    'network 192.168.3.0 0.0.0.255 area 0',
    'network 10.0.13.0 0.0.0.3 area 0', 'network 10.0.23.0 0.0.0.3 area 0', 'end',
  ]);

  return { r1, r2, r3, c13 };
}

describe('OSPF — convergence quand un lien tombe', () => {
  it('retire du domaine le sous-réseau du lien mort', async () => {
    const { r1, r2, c13 } = await triangle();
    expect(await r2.executeCommand('show ip route ospf')).toContain('10.0.13.0');

    c13.disconnect();
    await settle();

    expect(await r2.executeCommand('show ip route ospf')).not.toContain('10.0.13.0');
    expect(await r1.executeCommand('show ip route')).not.toContain('10.0.13.0');
  });

  it('réachemine par le chemin de secours au lieu de perdre la destination', async () => {
    const { r1, c13 } = await triangle();
    expect(await r1.executeCommand('show ip route ospf')).toMatch(/192\.168\.3\.0.*10\.0\.13\.2/);

    c13.disconnect();
    await settle();

    const routes = await r1.executeCommand('show ip route ospf');
    expect(routes).toContain('192.168.3.0');
    expect(routes).toMatch(/192\.168\.3\.0.*10\.0\.12\.2/);
    expect(await r1.executeCommand('ping 192.168.3.1')).toContain('Success rate is 100 percent');
  });

  it('ne ressuscite pas l\'interface dont le câble est parti, même après un show', async () => {
    const { r2, c13 } = await triangle();
    c13.disconnect();
    await settle();

    await r2.executeCommand('show ip ospf interface brief');
    await r2.executeCommand('show ip route');
    await r2.executeCommand('show ip ospf database');

    expect(await r2.executeCommand('show ip route ospf')).not.toContain('10.0.13.0');
  });

  it('remonte l\'adjacence jusqu\'à FULL quand le câble revient', async () => {
    const { r1, r2, r3, c13 } = await triangle();
    c13.disconnect();
    await settle();
    expect(await r1.executeCommand('show ip ospf neighbor')).not.toContain('3.3.3.3');

    const back = new Cable('c13-bis');
    back.connect(r1.getPort('GigabitEthernet0/2')!, r3.getPort('GigabitEthernet0/1')!);
    await settle();

    const nei = await r1.executeCommand('show ip ospf neighbor');
    expect(nei).toContain('3.3.3.3');
    expect(nei).toContain('FULL');
    expect(nei).not.toContain('LOADING');
    expect(await r1.executeCommand('show ip route')).toContain('10.0.13.0/30 is directly connected');
    expect(await r2.executeCommand('show ip route ospf')).toContain('10.0.13.0');
    expect(await r1.executeCommand('ping 192.168.3.1')).toContain('Success rate is 100 percent');
  });
});
