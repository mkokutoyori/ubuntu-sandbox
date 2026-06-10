/**
 * Topology save/load round-trip (export → JSON → import).
 *
 * Before this fix the serializer only captured per-port IP/mask: default
 * gateways and user-configured static routes silently disappeared on every
 * save/load cycle, breaking inter-subnet connectivity of restored labs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Equipment } from '@/network/equipment/Equipment';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { exportTopology, importTopology, type TopologyExport } from '@/store/topologySerializer';
import type { Connection } from '@/store/networkStore';

function roundTrip(devices: Map<string, Equipment>, connections: Connection[] = []) {
  const exported = exportTopology('lab', devices, connections);
  // Serialize through JSON to ensure nothing depends on live object identity.
  const json = JSON.parse(JSON.stringify(exported)) as TopologyExport;
  return importTopology(json);
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('topology round-trip — end-host L3 configuration', () => {
  it('preserves the default gateway of a PC', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
    pc.setDefaultGateway(new IPAddress('192.168.1.1'));
    const devices = new Map<string, Equipment>([[pc.getId(), pc]]);

    const result = roundTrip(devices);

    const restored = [...result.deviceInstances.values()][0] as LinuxPC;
    expect(restored.getDefaultGateway()?.toString()).toBe('192.168.1.1');
  });

  it('preserves static routes of a PC, including the metric', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
    expect(pc.addStaticRoute(
      new IPAddress('10.50.0.0'), new SubnetMask('255.255.0.0'),
      new IPAddress('192.168.1.254'), 42,
    )).toBe(true);
    const devices = new Map<string, Equipment>([[pc.getId(), pc]]);

    const result = roundTrip(devices);

    const restored = [...result.deviceInstances.values()][0] as LinuxPC;
    const statics = restored.getRoutingTable().filter(r => r.type === 'static');
    expect(statics).toHaveLength(1);
    expect(statics[0].network.toString()).toBe('10.50.0.0');
    expect(statics[0].mask.toString()).toBe('255.255.0.0');
    expect(statics[0].nextHop?.toString()).toBe('192.168.1.254');
    expect(statics[0].metric).toBe(42);
  });

  it('preserves static routes of a router', () => {
    const r1 = new CiscoRouter('R1');
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.252'));
    expect(r1.addStaticRoute(
      new IPAddress('10.0.3.0'), new SubnetMask('255.255.255.0'),
      new IPAddress('10.0.2.2'),
    )).toBe(true);
    const devices = new Map<string, Equipment>([[r1.getId(), r1]]);

    const result = roundTrip(devices);

    const restored = [...result.deviceInstances.values()][0] as CiscoRouter;
    const statics = restored.getRoutingTable().filter(r => r.type === 'static');
    expect(statics).toHaveLength(1);
    expect(statics[0].network.toString()).toBe('10.0.3.0');
    expect(statics[0].nextHop?.toString()).toBe('10.0.2.2');
  });

  it('does not duplicate connected routes on import', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
    const devices = new Map<string, Equipment>([[pc.getId(), pc]]);

    const result = roundTrip(devices);

    const restored = [...result.deviceInstances.values()][0] as LinuxPC;
    const connected = restored.getRoutingTable().filter(r => r.type === 'connected');
    expect(connected.filter(r => r.iface === 'eth0')).toHaveLength(1);
  });

  it('imports legacy files without the new optional fields', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
    const devices = new Map<string, Equipment>([[pc.getId(), pc]]);

    const exported = JSON.parse(JSON.stringify(exportTopology('legacy', devices, []))) as TopologyExport;
    for (const d of exported.devices) {
      delete (d as Record<string, unknown>).defaultGateway;
      delete (d as Record<string, unknown>).staticRoutes;
    }

    expect(() => importTopology(exported)).not.toThrow();
  });

  it('skips malformed routes/gateways instead of failing the whole import', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
    const devices = new Map<string, Equipment>([[pc.getId(), pc]]);

    const exported = JSON.parse(JSON.stringify(exportTopology('bad', devices, []))) as TopologyExport;
    (exported.devices[0] as Record<string, unknown>).defaultGateway = 'not-an-ip';
    (exported.devices[0] as Record<string, unknown>).staticRoutes = [
      { network: '999.999.0.0', mask: '255.255.0.0', nextHop: '192.168.1.254' },
    ];

    const result = importTopology(exported);
    const restored = [...result.deviceInstances.values()][0] as LinuxPC;
    expect(restored.getDefaultGateway()).toBeNull();
    expect(restored.getRoutingTable().filter(r => r.type === 'static')).toHaveLength(0);
  });
});
