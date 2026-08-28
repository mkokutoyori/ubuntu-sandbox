import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import type { UDPPacket, IPv4Packet } from '@/network/core/types';
import { createIPv4Packet, IP_PROTO_UDP } from '@/network/core/types';
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

const wait = (ms = 60) => new Promise<void>(r => setTimeout(r, ms));

function labRouter() {
  const r = new CiscoRouter('R1', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -150, 0);
  r.powerOn(); pc.powerOn();
  new Cable('a').connect(pc.getPort('eth0')!, r.getPort('GigabitEthernet0/0')!);
  pc.getPort('eth0')!
    .configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { r, pc };
}

async function readyRouter() {
  const { r, pc } = labRouter();
  for (const line of [
    'enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
  ]) await (r as unknown as { executeCommand(c: string): Promise<string> }).executeCommand(line);
  return { r, pc };
}

function labHosts() {
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxPC('linux-pc', 'B', -150, 0);
  a.powerOn(); b.powerOn();
  new Cable('a').connect(a.getPort('eth0')!, b.getPort('eth0')!);
  a.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  b.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  return { a, b };
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

async function labSwitch() {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -150, 0);
  sw.powerOn(); pc.powerOn();
  new Cable('a').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  for (const l of ['enable', 'configure terminal', 'interface Vlan1',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end']) {
    await (sw as unknown as { executeCommand(c: string): Promise<string> }).executeCommand(l);
  }
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { sw, pc };
}

describe('a UDP port nobody listens on is announced, on every family', () => {
  it('WITNESS host: an unbound UDP port answers ICMP port unreachable', async () => {
    const { a } = labHosts();
    const seen = watchIcmp(a);

    a.sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 40000, 'nobody-home');
    await wait();

    console.log('host  -> reasons =', JSON.stringify(seen));
    expect(seen.some(r => /unreachable/i.test(r))).toBe(true);
  });

  it('ROUTER: an unbound UDP port answers ICMP port unreachable', async () => {
    const { pc } = await readyRouter();
    const seen = watchIcmp(pc);

    expect(await pc.executeCommand('ping -c 1 10.0.0.1')).toMatch(/, 0% packet loss/);

    pc.sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 40000, 'nobody-home');
    await wait();

    console.log('router -> reasons =', JSON.stringify(seen));
    expect(seen.some(r => /unreachable/i.test(r))).toBe(true);
  });

  it('SWITCH SVI: an unbound UDP port answers ICMP port unreachable', async () => {
    const { pc } = await labSwitch();
    const seen = watchIcmp(pc);

    expect(await pc.executeCommand('ping -c 1 10.0.0.1')).toMatch(/, 0% packet loss/);
    pc.sendUdpDatagram(new IPAddress('10.0.0.1'), 9999, 40000, 'nobody-home');
    await wait();

    console.log('switch -> reasons =', JSON.stringify(seen));
    expect(seen.some(r => /unreachable/i.test(r))).toBe(true);
  });

  it('ROUTER: binding a port the hardcoded chain owns is refused, not shadowed', async () => {
    const { r } = await readyRouter();
    const endpoint = r.getUdpEndpoint();

    expect(endpoint.udpBind(520, () => undefined)).toBe(false);
    expect(endpoint.udpBind(161, () => undefined)).toBe(false);
    expect(endpoint.udpBind(9999, () => undefined)).toBe(true);
  });

  it('ROUTER: the port table names the owner of a reserved port', async () => {
    const { r } = await readyRouter();

    expect(r.getUdpEndpoint().ownerOf(520)).toBe('rip');
    expect(r.getUdpEndpoint().ownerOf(67)).toBe('dhcpd');
    expect(r.getUdpEndpoint().ownerOf(9999)).toBeNull();
  });

  it('ROUTER: a datagram on a bound control-plane port reaches its handler', async () => {
    const { r, pc } = await readyRouter();
    const got: number[] = [];
    r.getUdpEndpoint().udpBind(3333, () => { got.push(1); });

    pc.sendUdpDatagram(new IPAddress('10.0.0.1'), 3333, 40000, 'hello');
    await wait();

    console.log('bound 3333 deliveries =', got.length);
    expect(got.length).toBe(1);
  });

  for (const [vendor, build, ports] of [
    ['Cisco', () => new CiscoRouter('R', 0, 0),
      [1985, 123, 3222, 3784, 1812, 1813, 3799, 161, 4789]],
    ['Huawei', () => new HuaweiRouter('R', 0, 0),
      [123, 3784, 1812, 1813, 3799, 161, 4789]],
  ] as const) {
    it(`${vendor}: every port the owner table declares is really claimed`, () => {
      const router = build();
      const probe = router as unknown as {
        controlPlaneUdpOwner(port: number): string | null;
        receiveControlPlaneUdp(inPort: string, ipPkt: IPv4Packet, udp: UDPPacket): boolean;
      };

      for (const port of ports) {
        expect(probe.controlPlaneUdpOwner(port)).not.toBeNull();

        const udp: UDPPacket = {
          type: 'udp', sourcePort: 40000, destinationPort: port,
          length: 8, checksum: 0, payload: undefined,
        };
        const ipPkt = createIPv4Packet(
          new IPAddress('10.0.0.2'), new IPAddress('10.0.0.1'),
          IP_PROTO_UDP, 64, udp, 28);

        expect(probe.receiveControlPlaneUdp('GigabitEthernet0/0', ipPkt, udp)).toBe(true);
      }
    });
  }

  it('never answers an unclaimed BROADCAST datagram (RFC 1122 §3.2.2)', async () => {
    const { pc } = await readyRouter();
    const seen = watchIcmp(pc);

    pc.sendUdpDatagram(new IPAddress('255.255.255.255'), 9999, 40000, 'broadcast');
    await wait();

    expect(seen).toEqual([]);
  });

  it('never answers an unclaimed MULTICAST datagram', async () => {
    const { pc } = await readyRouter();
    const seen = watchIcmp(pc);

    pc.sendUdpDatagram(new IPAddress('224.0.0.9'), 9999, 40000, 'multicast');
    await wait();

    expect(seen).toEqual([]);
  });

  it('a DHCP discover still reaches the router and draws no ICMP error', async () => {
    const { r, pc } = await readyRouter();
    for (const line of [
      'configure terminal', 'ip dhcp pool LAB', 'network 10.0.0.0 255.255.255.0',
      'default-router 10.0.0.1', 'end',
    ]) await (r as unknown as { executeCommand(c: string): Promise<string> }).executeCommand(line);
    const seen = watchIcmp(pc);

    pc.sendUdpDatagram(new IPAddress('255.255.255.255'), 67, 68, 'discover');
    await wait();

    expect(seen).toEqual([]);
  });
});