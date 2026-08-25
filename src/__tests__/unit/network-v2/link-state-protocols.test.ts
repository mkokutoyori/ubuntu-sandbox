import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

async function ospfPair(): Promise<{ r1: CiscoRouter; r2: CiscoRouter; cable: Cable }> {
  const r1 = new CiscoRouter('router-cisco', 'R1');
  const r2 = new CiscoRouter('router-cisco', 'R2');
  const cable = new Cable('c1');
  cable.connect(r1.getPorts()[0], r2.getPorts()[0]);

  for (const [r, ip] of [[r1, '10.0.2.1'], [r2, '10.0.2.2']] as const) {
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand(`ip address ${ip} 255.255.255.0`);
    await r.executeCommand('no shutdown');
    await r.executeCommand('exit');
    await r.executeCommand('router ospf 1');
    await r.executeCommand('network 10.0.2.0 0.0.0.255 area 0');
    await r.executeCommand('end');
  }
  return { r1, r2, cable };
}

describe('link-down is observable on the event bus (docs/PRD-Link-State.md §1.3, P7)', () => {
  it('unplugging publishes port.link.down for both ends', () => {
    const r1 = new CiscoRouter('router-cisco', 'R1');
    const r2 = new CiscoRouter('router-cisco', 'R2');
    const cable = new Cable('c1');
    cable.connect(r1.getPorts()[0], r2.getPorts()[0]);

    const downs: string[] = [];
    const unsubs = [r1, r2].map(r => r.getBus().subscribe('port.link.down', (e) => {
      downs.push(e.payload.deviceId);
    }));
    cable.disconnect();
    unsubs.forEach(u => u());

    expect(downs).toHaveLength(2);
  });

  it('a cable brought administratively down publishes it too', () => {
    const r1 = new CiscoRouter('router-cisco', 'R1');
    const r2 = new CiscoRouter('router-cisco', 'R2');
    const cable = new Cable('c1');
    cable.connect(r1.getPorts()[0], r2.getPorts()[0]);

    const downs: string[] = [];
    const unsubs = [r1, r2].map(r => r.getBus().subscribe('port.link.down', () => { downs.push('x'); }));
    cable.setUp(false);
    unsubs.forEach(u => u());

    expect(downs).toHaveLength(2);
  });
});

describe('OSPF adjacency follows the link (docs/PRD-Link-State.md §4 #13, P7)', () => {
  it('the neighbour is learned over a live link and dropped when it is pulled', async () => {
    const { r1, cable } = await ospfPair();
    const before = await r1.executeCommand('show ip ospf neighbor');
    expect(before).toContain('10.0.2.2');

    cable.disconnect();

    const after = await r1.executeCommand('show ip ospf neighbor');
    expect(after).not.toContain('10.0.2.2');
  }, 30000);

  it('the connected route over the severed link leaves the routing table', async () => {
    const { r1, cable } = await ospfPair();
    expect(await r1.executeCommand('show ip route')).toContain('10.0.2.0');

    cable.disconnect();

    const after = await r1.executeCommand('show ip route');
    expect(after).not.toMatch(/^C\s+10\.0\.2\.0/m);
  }, 30000);
});

describe('interface state reporting on a severed link (P7)', () => {
  it('show ip interface brief reports the line protocol as down', async () => {
    const { r1, cable } = await ospfPair();
    cable.disconnect();
    const out = await r1.executeCommand('show ip interface brief');
    const line = out.split('\n').find((l) => l.includes('10.0.2.1'));
    expect(line).toBeDefined();
    expect(line!.toLowerCase()).toContain('down');
  }, 30000);
});
