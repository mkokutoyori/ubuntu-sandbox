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

interface Cli { executeCommand(command: string): Promise<string> }

async function type(device: Cli, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function lab(farMtu = 1500) {
  const router = new CiscoRouter('R1', 0, 0);
  const near = new LinuxPC('linux-pc', 'NEAR', -150, 0);
  const far = new LinuxPC('linux-pc', 'FAR', 150, 0);
  router.powerOn(); near.powerOn(); far.powerOn();

  new Cable('a').connect(near.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(far.getPort('eth0')!, router.getPort('GigabitEthernet0/1')!);

  await type(router as unknown as Cli, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0',
    `ip mtu ${farMtu}`, 'no shutdown', 'end',
  ]);

  for (const [pc, ip, gw] of [
    [near, '10.0.0.2', '10.0.0.1'], [far, '10.0.1.2', '10.0.1.1'],
  ] as const) {
    await type(pc as unknown as Cli, ['ip link set eth0 up']);
    pc.getPort('eth0')!.configureIP(new IPAddress(ip), new SubnetMask('255.255.255.0'));
    await type(pc as unknown as Cli, [`ip route add default via ${gw}`]);
  }
  return { router, near, far };
}

function watchIcmp(sender: LinuxPC): string[] {
  const seen: string[] = [];
  (sender as unknown as { getBus(): { subscribe(t: string, f: (e: unknown) => void): void } })
    .getBus().subscribe('host.icmp.echo-failed', (e: unknown) => {
      const reason = (e as { payload?: { reason?: string } }).payload?.reason;
      if (reason) seen.push(reason);
    });
  return seen;
}

const silence = (router: CiscoRouter, iface = 'GigabitEthernet0/0') => type(
  router as unknown as Cli,
  ['configure terminal', `interface ${iface}`, 'no ip unreachables', 'end']);

describe('`no ip unreachables` silences ICMP type 3, and only type 3', () => {
  it('WITNESS: a port unreachable is sent while unreachables are enabled', async () => {
    const { near } = await lab();
    const seen = watchIcmp(near);

    near.sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 40000, 'nobody-home');
    await wait();

    expect(seen.some(r => /unreachable/i.test(r))).toBe(true);
  });

  it('silences the port unreachable', async () => {
    const { router, near } = await lab();
    await silence(router);
    const seen = watchIcmp(near);

    near.sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 40000, 'nobody-home');
    await wait();

    expect(seen).toEqual([]);
  });

  it('silences the host unreachable for an unroutable destination', async () => {
    const { router, near } = await lab();
    await silence(router);
    const seen = watchIcmp(near);

    near.sendUdpDatagram(new IPAddress('203.0.113.9'), 9999, 40000, 'nowhere');
    await wait();

    expect(seen).toEqual([]);
  });

  it('silences Fragmentation Needed, which is what breaks PMTUD', async () => {
    const { router, near } = await lab(600);

    const before = await near.executeCommand('ping -M do -s 1200 -c 1 10.0.1.2');
    expect(before).toMatch(/[Ff]rag|too long|mtu|unreachable/i);

    await silence(router);
    const after = await near.executeCommand('ping -M do -s 1200 -c 1 10.0.1.2');

    expect(after).toMatch(/100% packet loss/);
    expect(after).not.toMatch(/[Ff]rag|mtu/i);
  });

  it('does NOT silence Time Exceeded, so traceroute still works', async () => {
    const { router, near } = await lab();
    await silence(router);

    const out = await near.executeCommand('ping -t 1 -c 1 10.0.1.2');

    expect(out).toMatch(/[Tt]ime to live exceeded|[Tt]ime exceeded|ttl/i);
  });

  it('is per interface: silencing one leaves the other speaking', async () => {
    const { router, near, far } = await lab();
    await silence(router, 'GigabitEthernet0/1');
    const seen = watchIcmp(near);
    void far;

    near.sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 40000, 'nobody-home');
    await wait();

    expect(seen.some(r => /unreachable/i.test(r))).toBe(true);
  });

  it('`ip unreachables` puts the message back', async () => {
    const { router, near } = await lab();
    await silence(router);
    await type(router as unknown as Cli,
      ['configure terminal', 'interface GigabitEthernet0/0', 'ip unreachables', 'end']);
    const seen = watchIcmp(near);

    near.sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 40000, 'nobody-home');
    await wait();

    expect(seen.some(r => /unreachable/i.test(r))).toBe(true);
  });
});
