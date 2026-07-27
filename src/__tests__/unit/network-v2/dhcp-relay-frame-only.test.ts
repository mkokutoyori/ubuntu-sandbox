/**
 * A DHCP lease obtained across an `ip helper-address` relay must come
 * from frames alone. The proof is to build the topology, then take the
 * global registry away: anything that still works cannot have been
 * walking the equipment graph.
 *
 * See docs/PRD-Frame-Only-Refactor.md P5.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function relayLan() {
  const sw = new CiscoSwitch('switch-cisco', 'L3SW', 26, 0, 0);
  const router = new CiscoRouter('DHCP-SRV');
  const pc = new LinuxPC('pc1', 'PC1', 0, 0);

  new Cable('c1').connect(pc.getPorts()[0], sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(sw.getPort('GigabitEthernet0/1')!, router.getPorts()[0]);

  for (const cmd of [
    'enable', 'configure terminal', 'ip routing',
    'vlan 10', 'exit',
    'interface FastEthernet0/1',
    'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface Vlan10',
    'ip address 10.0.10.1 255.255.255.0',
    'ip helper-address 10.0.100.1',
    'no shutdown', 'exit',
    'vlan 100', 'exit',
    'interface GigabitEthernet0/1',
    'switchport mode access', 'switchport access vlan 100', 'exit',
    'interface Vlan100',
    'ip address 10.0.100.2 255.255.255.0', 'no shutdown', 'exit',
    'end',
  ]) await sw.executeCommand(cmd);

  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    'ip address 10.0.100.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.0.10.0 255.255.255.0 10.0.100.2',
    'ip dhcp excluded-address 10.0.10.1 10.0.10.99',
    'ip dhcp pool VLAN10',
    'network 10.0.10.0 255.255.255.0',
    'default-router 10.0.10.1',
    'lease 1', 'exit', 'end',
  ]) await router.executeCommand(cmd);

  return { sw, router, pc };
}

/**
 * Leave the registry in place but make every lookup throw, so a
 * surviving graph walk fails loudly instead of quietly returning
 * nothing and looking like an ordinary DHCP timeout.
 */
function makeRegistryUnusable(): void {
  const reg = EquipmentRegistry.getInstance() as unknown as Record<string, unknown>;
  const refuse = (name: string) => () => {
    throw new Error(`EquipmentRegistry.${name} reached during a frame-only path`);
  };
  reg.getAll = refuse('getAll');
  reg.getById = refuse('getById');
}

describe('a DHCP lease across a relay survives the registry going away', () => {
  it('the client still completes DORA with no registry to walk', async () => {
    const { pc } = await relayLan();
    makeRegistryUnusable();

    const out = await pc.executeCommand('dhclient -v eth0');
    expect(out).toMatch(/DHCPDISCOVER/);
    expect(out).toMatch(/DHCPOFFER of 10\.0\.10\.\d+/);
    expect(out).toMatch(/DHCPACK of 10\.0\.10\.\d+/);
  }, 30000);

  it('the address really lands on the interface, from the relayed pool', async () => {
    const { pc } = await relayLan();
    makeRegistryUnusable();

    await pc.executeCommand('dhclient eth0');
    const out = await pc.executeCommand('ip addr show eth0');
    expect(
      out,
      'the pool lives on a router the client can only reach through the relay',
    ).toMatch(/inet 10\.0\.10\.\d+/);
  }, 30000);

  it('the central server records the binding, so the relay really carried it', async () => {
    const { router, pc } = await relayLan();
    makeRegistryUnusable();

    await pc.executeCommand('dhclient eth0');
    const out = await router.executeCommand('show ip dhcp binding');
    expect(out).toMatch(/10\.0\.10\.\d+/);
  }, 30000);

  it('an uncabled client gets nothing — the lease is not coming from a global scan', async () => {
    const orphan = new LinuxPC('pc2', 'PC2', 0, 0);
    await relayLan();
    makeRegistryUnusable();

    const out = await orphan.executeCommand('dhclient -v eth0');
    expect(
      out,
      'with no cable there is no segment to broadcast on, so no lease can exist',
    ).not.toMatch(/DHCPACK of 10\.0\.10\.\d+/);
  }, 30000);
});
