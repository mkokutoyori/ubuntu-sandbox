import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  Logger.reset(); EquipmentRegistry.resetInstance();
});

const wait = (ms = 80) => new Promise<void>(r => setTimeout(r, ms));

async function transitLab() {
  const r = new CiscoRouter('R1', 0, 0);
  const left = new LinuxPC('linux-pc', 'L', -150, 0);
  const right = new LinuxPC('linux-pc', 'R', 150, 0);
  r.powerOn(); left.powerOn(); right.powerOn();

  new Cable('a').connect(left.getPort('eth0')!, r.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(right.getPort('eth0')!, r.getPort('GigabitEthernet0/1')!);

  for (const line of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'end',
  ]) await (r as unknown as { executeCommand(c: string): Promise<string> }).executeCommand(line);

  for (const [pc, ip, gw] of [
    [left, '10.0.0.2', '10.0.0.1'], [right, '10.0.1.2', '10.0.1.1'],
  ] as const) {
    await (pc as unknown as { executeCommand(c: string): Promise<string> })
      .executeCommand('ip link set eth0 up');
    (pc as LinuxPC).getPort('eth0')!
      .configureIP(new IPAddress(ip), new SubnetMask('255.255.255.0'));
    await (pc as unknown as { executeCommand(c: string): Promise<string> })
      .executeCommand(`ip route add default via ${gw}`);
  }
  return { r, left, right };
}

describe('a router must FORWARD transit UDP, not eat it', () => {
  it('WITNESS: an ordinary UDP port crosses the router', async () => {
    const { left, right } = await transitLab();
    const got: number[] = [];
    right.udpBind(40001, () => { got.push(1); });

    expect(await left.executeCommand('ping -c 1 10.0.1.2')).toMatch(/, 0% packet loss/);
    left.sendUdpDatagram(new IPAddress('10.0.1.2'), 40001, 40000, 'transit');
    await wait();

    console.log('port 40001 (ordinary)  deliveries =', got.length);
    expect(got.length).toBe(1);
  });

  for (const [name, port] of [
    ['SNMP', 161], ['NTP', 123], ['RADIUS auth', 1812],
    ['BFD control', 3784], ['HSRP', 1985],
  ] as const) {
    it(`transit UDP on ${name} (${port}) reaches the far host`, async () => {
      const { left, right } = await transitLab();
      const got: number[] = [];
      right.udpBind(port, () => { got.push(1); });

      left.sendUdpDatagram(new IPAddress('10.0.1.2'), port, 40000, 'transit');
      await wait();

      console.log(`port ${port} (${name}) deliveries =`, got.length);
      expect(got.length).toBe(1);
    });
  }
});
