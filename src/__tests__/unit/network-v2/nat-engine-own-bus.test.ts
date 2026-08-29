import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const MASK = new SubnetMask('255.255.255.0');

interface Cli { executeCommand(command: string): Promise<string> }

async function type(device: Cli, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function natRouter(name: string, insideIp: string, outsideIp: string): Promise<CiscoRouter> {
  const r = new CiscoRouter(name, 0, 0);
  r.powerOn();
  await type(r as unknown as Cli, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', `ip address ${insideIp} 255.255.255.0`,
    'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', `ip address ${outsideIp} 255.255.255.0`,
    'ip nat outside', 'no shutdown', 'exit',
    'access-list 1 permit 10.0.0.0 0.0.0.255',
    'ip nat inside source list 1 interface GigabitEthernet0/1 overload',
    'end',
  ]);
  return r;
}

function natTopicsOf(router: CiscoRouter): string[] {
  const seen: string[] = [];
  (router as unknown as { getBus(): { subscribeAll(h: (e: { topic: string }) => void): void } })
    .getBus().subscribeAll((e) => { if (e.topic.startsWith('nat.')) seen.push(e.topic); });
  return seen;
}

async function host(name: string, ip: string, gateway: string): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', name, 0, 0);
  pc.powerOn();
  await type(pc as unknown as Cli, ['ip link set eth0 up']);
  pc.getPort('eth0')!.configureIP(new IPAddress(ip), MASK);
  await type(pc as unknown as Cli, [`ip route add default via ${gateway}`]);
  return pc;
}

describe('a router NAT engine publishes on its own bus, not a shared one', () => {
  it('a real translated flow is seen on the translating router and nowhere else', async () => {
    const a = await natRouter('R_A', '10.0.0.1', '203.0.113.1');
    const b = await natRouter('R_B', '10.1.0.1', '203.0.113.2');
    const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
    const client = await host('CLIENT', '10.0.0.10', '10.0.0.1');
    const server = await host('SERVER', '203.0.113.9', '203.0.113.1');

    new Cable('c1').connect(client.getPort('eth0')!, a.getPort('GigabitEthernet0/0')!);
    new Cable('c2').connect(a.getPort('GigabitEthernet0/1')!, sw.getPorts()[0]);
    new Cable('c3').connect(server.getPort('eth0')!, sw.getPorts()[1]);
    new Cable('c4').connect(b.getPort('GigabitEthernet0/1')!, sw.getPorts()[2]);

    const onA = natTopicsOf(a);
    const onB = natTopicsOf(b);

    const ping = await client.executeCommand('ping -c 2 203.0.113.9');

    expect(ping, 'the lab must actually carry traffic, or nothing below proves anything')
      .toMatch(/, 0% packet loss/);
    expect(onA, 'the translating router sees its own NAT events').not.toEqual([]);
    expect(
      onB,
      'B subscribed to its own bus — an event from A must never be delivered there, '
      + 'not merely filtered out by a predicate once it has arrived',
    ).toEqual([]);
  }, 30000);

  it('the translation is visible on the translating router alone', async () => {
    const a = await natRouter('R_A', '10.0.0.1', '203.0.113.1');
    const b = await natRouter('R_B', '10.1.0.1', '203.0.113.2');
    const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
    const client = await host('CLIENT', '10.0.0.10', '10.0.0.1');
    const server = await host('SERVER', '203.0.113.9', '203.0.113.1');

    new Cable('c1').connect(client.getPort('eth0')!, a.getPort('GigabitEthernet0/0')!);
    new Cable('c2').connect(a.getPort('GigabitEthernet0/1')!, sw.getPorts()[0]);
    new Cable('c3').connect(server.getPort('eth0')!, sw.getPorts()[1]);
    new Cable('c4').connect(b.getPort('GigabitEthernet0/1')!, sw.getPorts()[2]);

    await client.executeCommand('ping -c 2 203.0.113.9');

    expect(await a.executeCommand('show ip nat translations')).toContain('10.0.0.10');
    expect(await b.executeCommand('show ip nat translations')).not.toContain('10.0.0.10');
  }, 30000);
});
