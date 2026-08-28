import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { Equipment } from '@/network/equipment/Equipment';
import type { L3Interface } from '@/network/devices/firewall/l3/InterfaceTable';

interface FirewallUnderTest extends Equipment {
  executeCommand(command: string): Promise<string>;
  listL3Interfaces(): readonly L3Interface[];
}

interface Host {
  executeCommand(command: string): Promise<string>;
  getTcpStack(): { connect(ip: string, port: number, handlers: object): { state: string } | null };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab(): Promise<{ firewall: FirewallUnderTest; pc: LinuxPC & Host }> {
  const firewall = createDevice('firewall-fortinet', 0, 0) as unknown as FirewallUnderTest;
  const pc = new LinuxPC('linux-pc', 'PC', -150, 0) as LinuxPC & Host;
  pc.powerOn();
  new Cable('a').connect(pc.getPort('eth0')!, firewall.getPort('port1')!);
  await pc.executeCommand('ip link set eth0 up');
  await pc.executeCommand('ip addr add 192.168.1.10/24 dev eth0');
  return { firewall, pc };
}

const ipOf = (device: Equipment, port: string): string | undefined =>
  device.getPort(port)?.getIPAddress()?.toString();

const tableEntry = (firewall: FirewallUnderTest, name: string): L3Interface | undefined =>
  firewall.listL3Interfaces().find(entry => entry.name === name);

describe('a firewall interface is the port, not a copy of it', () => {
  it('carries the factory address on the port the UI reads', async () => {
    const { firewall } = await lab();

    expect(ipOf(firewall, 'port1')).toBe('192.168.1.99');
    expect(firewall.getPort('port1')?.getSubnetMask()?.toString()).toBe('255.255.255.0');
  });

  it('shows the same address through the port and through the table', async () => {
    const { firewall } = await lab();

    expect(tableEntry(firewall, 'port1')?.ip).toBe(ipOf(firewall, 'port1'));
    expect(tableEntry(firewall, 'port1')?.mask)
      .toBe(firewall.getPort('port1')?.getSubnetMask()?.toString());
  });

  it('moves the port address when the CLI reconfigures the interface', async () => {
    const { firewall } = await lab();

    for (const line of ['config system interface', 'edit port1', 'set mode static',
      'set ip 10.20.30.1 255.255.255.0', 'next', 'end']) {
      await firewall.executeCommand(line);
    }

    expect(ipOf(firewall, 'port1')).toBe('10.20.30.1');
    expect(tableEntry(firewall, 'port1')?.ip).toBe('10.20.30.1');
  });

  it('brings the port down when the CLI shuts the interface', async () => {
    const { firewall } = await lab();

    for (const line of ['config system interface', 'edit port1',
      'set status down', 'next', 'end']) {
      await firewall.executeCommand(line);
    }

    expect(firewall.getPort('port1')?.getIsUp()).toBe(false);
    expect(tableEntry(firewall, 'port1')?.up).toBe(false);
  });

  it('moves the port MTU when the CLI overrides it', async () => {
    const { firewall } = await lab();

    for (const line of ['config system interface', 'edit port1',
      'set mtu-override enable', 'set mtu 1400', 'next', 'end']) {
      await firewall.executeCommand(line);
    }

    expect(firewall.getPort('port1')?.getMTU()).toBe(1400);
    expect(tableEntry(firewall, 'port1')?.mtu).toBe(1400);
  });

  it('answers a real TCP dial on its management ports', async () => {
    const { firewall, pc } = await lab();
    void firewall;

    for (const port of [22, 80, 443]) {
      expect(pc.getTcpStack().connect('192.168.1.99', port, {})?.state).toBe('established');
    }
  });

  it('is found by address, so ssh reaches the server instead of failing to route', async () => {
    const { pc } = await lab();

    const out = await pc.executeCommand('ssh -o StrictHostKeyChecking=no admin@192.168.1.99 x');

    expect(out).not.toMatch(/No route to host/);
  });

  it('still answers ping at its factory address', async () => {
    const { pc } = await lab();

    expect(await pc.executeCommand('ping -c 2 192.168.1.99')).toMatch(/, 0% packet loss/);
  });
});
