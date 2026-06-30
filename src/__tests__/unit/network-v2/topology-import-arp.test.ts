import { describe, it, expect } from 'vitest';
import { importTopology, type TopologyExport } from '@/store/topologySerializer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';

const TOPOLOGY: TopologyExport = {
  version: 1,
  projectName: 'default_wan',
  exportedAt: '2026-06-29T11:46:20.784Z',
  devices: [
    { id: 'a', type: 'linux-pc', name: 'PC4', hostname: 'PC4', x: 0, y: 0, isPoweredOn: true,
      interfaces: [{ name: 'eth0', ipAddress: '192.168.2.1', subnetMask: '255.255.255.0' }] },
    { id: 'b', type: 'linux-pc', name: 'PC5', hostname: 'PC5', x: 0, y: 0, isPoweredOn: true,
      interfaces: [{ name: 'eth0', ipAddress: '192.168.2.2', subnetMask: '255.255.255.0' }] },
    { id: 'c', type: 'switch-huawei', name: 'Switch2', hostname: 'Switch2', x: 0, y: 0, isPoweredOn: true,
      interfaces: [{ name: 'GigabitEthernet0/0/0' }, { name: 'GigabitEthernet0/0/1' }] },
  ],
  connections: [
    { sourceDeviceId: 'a', sourceInterfaceId: 'eth0',
      targetDeviceId: 'c', targetInterfaceId: 'GigabitEthernet0/0/0', type: 'ethernet' },
    { sourceDeviceId: 'b', sourceInterfaceId: 'eth0',
      targetDeviceId: 'c', targetInterfaceId: 'GigabitEthernet0/0/1', type: 'ethernet' },
  ],
};

describe('JSON import → ARP works after ping', () => {
  it('PC4 pings PC5 → arp shows PC5 entry', async () => {
    EquipmentRegistry.resetInstance();
    const { deviceInstances } = importTopology(TOPOLOGY);

    const pc4 = Array.from(deviceInstances.values()).find(d => d.getName() === 'PC4') as LinuxPC;
    const pc5 = Array.from(deviceInstances.values()).find(d => d.getName() === 'PC5') as LinuxPC;
    expect(pc4).toBeTruthy();
    expect(pc5).toBeTruthy();

    const pingOut = await pc4.executeCommand('ping -c 1 -W 1 192.168.2.2');
    expect(pingOut).toContain('1 received');

    const arpOut = await pc4.executeCommand('arp');
    expect(arpOut).toContain('192.168.2.2');
  });

  it('Importing populates connected routes (host can reach its own subnet peer)', async () => {
    EquipmentRegistry.resetInstance();
    const { deviceInstances } = importTopology(TOPOLOGY);
    const pc4 = Array.from(deviceInstances.values()).find(d => d.getName() === 'PC4') as LinuxPC;
    const routeOut = await pc4.executeCommand('route -n');
    expect(routeOut).toContain('192.168.2.0');
  });
});
