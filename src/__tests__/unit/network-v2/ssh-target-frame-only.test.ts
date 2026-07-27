/**
 * An `ssh` target is found by following cables from the machine running
 * the command, not by scanning every device in the simulation. The proof
 * is to build the topology and then make the global registry throw.
 *
 * See docs/PRD-Frame-Only-Refactor.md P6.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
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

const MASK = new SubnetMask('255.255.255.0');

function makeRegistryUnusable(): void {
  const reg = EquipmentRegistry.getInstance() as unknown as Record<string, unknown>;
  const refuse = (name: string) => () => {
    throw new Error(`EquipmentRegistry.${name} reached while resolving an ssh target`);
  };
  reg.getAll = refuse('getAll');
  reg.getById = refuse('getById');
}

async function lan() {
  const pc = new LinuxPC('linux-pc', 'CLI1', 0, 0);
  const server = new LinuxServer('linux-server', 'SRV1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  pc.getPorts()[0].configureIP(new IPAddress('192.168.4.10'), MASK);
  server.getPorts()[0].configureIP(new IPAddress('192.168.4.20'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  return { pc, server, sw };
}

describe('an ssh target is resolved by following the cables', () => {
  it('reaches a server across a switch with the registry refusing every lookup', async () => {
    const { pc } = await lan();
    makeRegistryUnusable();

    const out = await pc.executeCommand('ssh -o BatchMode=yes alice@192.168.4.20 whoami');
    expect(
      out,
      'the target sits two cables away; nothing but the cable plant can find it',
    ).not.toMatch(/No route to host|Could not resolve/);
  }, 30000);

  it('an unreachable device with the right IP is not found', async () => {
    const { pc } = await lan();
    // Same address, no cable to it: a global scan would happily match this
    // one, a cable walk cannot see it at all.
    const island = new LinuxServer('linux-server', 'ISLAND', 0, 0);
    island.getPorts()[0].configureIP(new IPAddress('192.168.4.99'), MASK);
    makeRegistryUnusable();

    const out = await pc.executeCommand('ssh -o BatchMode=yes alice@192.168.4.99 whoami');
    expect(
      out,
      'no cable leads there, so ssh must fail rather than reach it anyway',
    ).toMatch(/No route to host|Connection|refused|timed out|Could not resolve/i);
  }, 30000);

  it('a port knows the device it belongs to, which is what replaces the registry', async () => {
    const { pc, sw } = await lan();
    const cable = pc.getPorts()[0].getCable();
    const farEnd = cable!.getPortA() === pc.getPorts()[0] ? cable!.getPortB() : cable!.getPortA();
    expect(farEnd!.getOwner()).toBe(sw);
  });
});
