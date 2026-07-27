/**
 * OSPF adjacency and route installation must not depend on reading the
 * global equipment registry. The topology is built and configured first,
 * then every registry lookup is made to throw, and the same behaviour is
 * required to still hold.
 *
 * Written before the conversion, as the safety net for the riskiest
 * phase of docs/PRD-Frame-Only-Refactor.md (P3).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
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

function makeRegistryUnusable(): void {
  const reg = EquipmentRegistry.getInstance() as unknown as Record<string, unknown>;
  const refuse = (name: string) => () => {
    throw new Error(`EquipmentRegistry.${name} reached during OSPF convergence`);
  };
  reg.getAll = refuse('getAll');
  reg.getById = refuse('getById');
}

async function ospfRouter(name: string, ifaceIps: Array<[string, string]>, networks: string[]) {
  const r = new CiscoRouter(name, 0, 0);
  const names = r.getPortNames();
  const cmds = ['enable', 'configure terminal', `hostname ${name}`];
  ifaceIps.forEach(([ip, mask], i) => {
    cmds.push(`interface ${names[i]}`, `ip address ${ip} ${mask}`, 'no shutdown', 'exit');
  });
  cmds.push('router ospf 1');
  for (const n of networks) cmds.push(`network ${n} area 0`);
  cmds.push('exit', 'end');
  for (const c of cmds) await r.executeCommand(c);
  return r;
}

/**
 * R1 — SW1 — SW2 — R2, the chained-switch case: two transparent devices
 * between the routers, so nothing resolves in a single hop.
 */
async function chainedSwitchDomain() {
  const r1 = await ospfRouter('R1', [['10.0.0.1', '255.255.255.0'], ['172.16.1.1', '255.255.255.0']],
    ['10.0.0.0 0.0.0.255', '172.16.1.0 0.0.0.255']);
  const r2 = await ospfRouter('R2', [['10.0.0.2', '255.255.255.0'], ['172.16.2.1', '255.255.255.0']],
    ['10.0.0.0 0.0.0.255', '172.16.2.0 0.0.0.255']);
  const sw1 = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);
  const sw2 = new GenericSwitch('switch-generic', 'SW2', 8, 0, 0);

  new Cable('c1').connect(r1.getPorts()[0], sw1.getPorts()[0]);
  new Cable('c2').connect(sw1.getPorts()[1], sw2.getPorts()[0]);
  new Cable('c3').connect(sw2.getPorts()[1], r2.getPorts()[0]);
  return { r1, r2, sw1, sw2 };
}

describe('OSPF converges across chained switches with no registry to read', () => {
  it('R1 reaches Full with R2 after the registry is trapped', async () => {
    const { r1 } = await chainedSwitchDomain();
    makeRegistryUnusable();

    const nb = await r1.executeCommand('show ip ospf neighbor');
    expect(
      nb,
      'the neighbour is two switches away; only a real flooded Hello can find it',
    ).toMatch(/FULL/i);
  }, 40000);

  it('R1 installs R2\'s LAN as an OSPF route under the same conditions', async () => {
    const { r1 } = await chainedSwitchDomain();
    makeRegistryUnusable();

    const routes = await r1.executeCommand('show ip route');
    expect(routes).toMatch(/O\s+172\.16\.2\.0/);
  }, 40000);

  it('R2 learns R1\'s LAN symmetrically', async () => {
    const { r2 } = await chainedSwitchDomain();
    makeRegistryUnusable();

    const routes = await r2.executeCommand('show ip route');
    expect(routes).toMatch(/O\s+172\.16\.1\.0/);
  }, 40000);

  it('a router on an unconnected island never becomes a neighbour', async () => {
    const { r1 } = await chainedSwitchDomain();
    // Same area, same subnet, no cable: a registry walk would pair with
    // it, a flooded Hello cannot reach it.
    await ospfRouter('R-ISLAND', [['10.0.0.9', '255.255.255.0']], ['10.0.0.0 0.0.0.255']);
    makeRegistryUnusable();

    const nb = await r1.executeCommand('show ip ospf neighbor');
    expect(nb, 'nothing physically connects that router to this domain').not.toMatch(/10\.0\.0\.9/);
  }, 40000);
});
