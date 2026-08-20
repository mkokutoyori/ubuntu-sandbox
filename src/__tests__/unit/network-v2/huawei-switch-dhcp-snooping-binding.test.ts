/**
 * Huawei switch DHCP snooping: `dhcp snooping enable` / `dhcp snooping
 * trusted` were previously cosmetic-only (recorded for `display this` but
 * never reaching the switch's real enforcement/binding engine), and
 * `display dhcp snooping user-bind all` didn't exist at all on the switch
 * shell. This covers the real, wire-driven binding table — the Huawei
 * equivalent of Cisco's already-real `show ip dhcp snooping binding`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import {
  MACAddress, IPAddress, ETHERTYPE_IPV4, IP_PROTO_UDP, createIPv4Packet, resetCounters,
} from '@/network/core/types';
import type { UDPPacket } from '@/network/core/types';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function buildLab() {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
  const r1 = new CiscoRouter('R1');
  for (const name of sw.getPortNames()) sw.getPort(name)!.setUp(true);

  new Cable('a').connect(h1.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);
  new Cable('b').connect(sw.getPort('GigabitEthernet0/0/2')!, r1.getPort('GigabitEthernet0/0')!);

  await run(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp pool LAN', 'network 10.0.1.0 255.255.255.0', 'default-router 10.0.1.1', 'exit',
    'ip dhcp excluded-address 10.0.1.1', 'end',
  ]);

  await run(sw, [
    'system-view',
    'dhcp snooping enable',
    'interface GigabitEthernet0/0/2', 'dhcp snooping trusted', 'quit',
  ]);

  return { h1, sw, r1 };
}

function makeOfferFrame(ethSrc: string, chaddr: string, xid = 1) {
  const offer = DHCPPacket.createOffer(chaddr, xid, '10.0.1.2', '10.0.1.1', {
    mask: '255.255.255.0', router: '10.0.1.1', dns: [], leaseDuration: 86400,
  });
  const udp: UDPPacket = {
    type: 'udp', sourcePort: 67, destinationPort: 68, length: 0, checksum: 0, payload: offer,
  };
  const ip = createIPv4Packet(new IPAddress('10.0.1.1'), new IPAddress('255.255.255.255'), IP_PROTO_UDP, 64, udp);
  return {
    srcMAC: new MACAddress(ethSrc),
    dstMAC: MACAddress.broadcast(),
    etherType: ETHERTYPE_IPV4,
    payload: ip,
  };
}

describe('Huawei DHCP snooping — real binding table', () => {
  it('records a real dynamic binding after a client leases through the switch', async () => {
    const { h1, sw } = await buildLab();

    const dora = await h1.executeCommand('dhclient -v eth0');
    expect(dora).toContain('DHCPACK');

    const out = await sw.executeCommand('display dhcp snooping user-bind all');
    expect(out).not.toMatch(/0 entries/i);
    expect(out.toLowerCase()).toContain('10.0.1.');
  });

  it('drops a server-sourced DHCP message arriving on an untrusted port', async () => {
    const h1 = new LinuxPC('linux-pc', 'H1');
    const sw = new HuaweiSwitch('switch-huawei', 'SW2', 8);
    for (const name of sw.getPortNames()) sw.getPort(name)!.setUp(true);
    new Cable('a').connect(h1.getPort('eth0')!, sw.getPort('GigabitEthernet0/0/1')!);

    await run(sw, ['system-view', 'dhcp snooping enable']);

    const before = sw._getDHCPSnoopingViolations();
    (sw as unknown as { handleFrame: (p: string, f: ReturnType<typeof makeOfferFrame>) => void }).handleFrame(
      'GigabitEthernet0/0/1',
      makeOfferFrame('aa:aa:aa:00:00:01', 'aa:aa:aa:00:00:01'),
    );

    expect(sw._getDHCPSnoopingViolations()).toBe(before + 1);
  });
});
