import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  Logger.reset(); EquipmentRegistry.resetInstance();
});

interface Cli { executeCommand(command: string): Promise<string> }
const type = async (d: Cli, lines: readonly string[]) => {
  for (const l of lines) await d.executeCommand(l);
};

async function collectorFor(device: Cli, stimulus: readonly string[]): Promise<string> {
  const pending = (collector as unknown as Cli).executeCommand('tcpdump -nn -e -c 1 udp port 514');
  await new Promise((r) => setTimeout(r, 20));
  await type(device, stimulus);
  await new Promise((r) => setTimeout(r, 40));
  return pending;
}

let collector: LinuxPC;

async function makeCollector(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'LOG', 0, 0);
  pc.powerOn();
  await type(pc as unknown as Cli, ['ip link set eth0 up']);
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.9'), new SubnetMask('255.255.255.0'));
  return pc;
}

describe('a syslog datagram reaches the collector, and is unicast to it', () => {
  it('WITNESS on a router: the collector receives it, addressed to its own MAC', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    collector = await makeCollector();
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, collector.getPort('eth0')!);
    await type(r as unknown as Cli, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'logging host 10.0.0.9', 'end',
    ]);

    const dump = await collectorFor(r as unknown as Cli,
      ['configure terminal', 'interface GigabitEthernet0/1', 'shutdown', 'no shutdown', 'end']);

    expect(dump).toMatch(/1 packet captured/);
    expect(dump).toContain(collector.getPort('eth0')!.getMAC().toString());
    expect(dump).not.toContain(MACAddress.broadcast().toString());
  }, 20000);

  it('a switch sends it too, and to the collector rather than to the whole VLAN', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    sw.powerOn();
    collector = await makeCollector();
    new Cable('c').connect(sw.getPort('FastEthernet0/1')!, collector.getPort('eth0')!);
    await type(sw as unknown as Cli, [
      'enable', 'configure terminal',
      'interface Vlan1', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'logging host 10.0.0.9', 'end',
    ]);
    expect(await (collector as unknown as Cli).executeCommand('ping -c 1 10.0.0.1'))
      .toMatch(/, 0% packet loss/);

    const dump = await collectorFor(sw as unknown as Cli,
      ['configure terminal', 'interface FastEthernet0/2', 'shutdown', 'no shutdown', 'end']);

    expect(dump).toMatch(/1 packet captured/);
    expect(dump).toContain(collector.getPort('eth0')!.getMAC().toString());
    expect(dump).not.toContain(MACAddress.broadcast().toString());
  }, 20000);
});
