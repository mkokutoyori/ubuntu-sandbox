/**
 * mDNS and LLMNR also speak on their IPv6 group.
 *
 * Both RFCs ask for one — `ff02::fb` (RFC 6762 §3), `ff02::1:3`
 * (RFC 4795 §2) — and both constants existed here, declared "for the
 * record", with an exact reason beside them: the v6 stack carried no
 * send path to any group. That path exists now.
 *
 * What is checked here is the WIRE, not the resolver: that a datagram
 * really leaves for the v6 group, and that what it carries is of use —
 * without AAAA, a v6-only link would see question and answer cross and
 * never learn an address.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Address, IPv6Packet } from '@/network/core/types';
import type { Equipment } from '@/network/equipment/Equipment';
import { MDNS_IPV6_GROUP, MDNS_BINDING, MDNS_PORT } from '@/network/mdns/types';
import { LLMNR_IPV6_GROUP, LLMNR_BINDING, LLMNR_PORT } from '@/network/llmnr/types';

interface V6Datagram {
  deviceId: string;
  dstMAC: string;
  destinationIP: string;
  destinationPort: number;
}

/** The v6 UDP datagrams actually requested on a port. */
function observeWire(source: Equipment): V6Datagram[] {
  const seen: V6Datagram[] = [];
  source.attachCapture(({ direction, frame }) => {
    if (direction !== 'out') return;
    const ip = frame.payload as IPv6Packet | undefined;
    if (!ip || ip.type !== 'ipv6') return;
    const udp = ip.payload as { type?: string; destinationPort?: number } | undefined;
    if (udp?.type !== 'udp') return;
    seen.push({
      deviceId: source.getId(),
      dstMAC: frame.dstMAC.toString().toLowerCase(),
      destinationIP: ip.destinationIP.toString(),
      destinationPort: udp.destinationPort ?? -1,
    });
  });
  return seen;
}

const configure6 = (h: LinuxPC, iface: string, address: string): void => {
  (h as unknown as {
    configureIPv6Interface(i: string, a: IPv6Address, p: number): boolean;
  }).configureIPv6Interface(iface, new IPv6Address(address), 64);
};

let a: LinuxPC;
let b: LinuxPC;

beforeEach(() => {
  a = new LinuxPC('A');
  b = new LinuxPC('B');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  a.powerOn(); b.powerOn(); sw.powerOn();
  new Cable('x').connect(a.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('y').connect(b.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  // Two fresh LinuxPCs share the SAME hostname, so without telling them
  // apart each would answer for the other's name.
  a.setHostname('alpha');
  b.setHostname('beta');
  configure6(a, 'eth0', '2001:db8::1');
  configure6(b, 'eth0', '2001:db8::2');
});

describe('the v6 group declaration', () => {
  it('both bindings now carry it instead of declaring it for the record', () => {
    expect(MDNS_BINDING.group6).toBe(MDNS_IPV6_GROUP);
    expect(LLMNR_BINDING.group6).toBe(LLMNR_IPV6_GROUP);
  });
});

describe('mDNS sends on ff02::fb', () => {
  it('an announcement leaves for the v6 group, at the right Ethernet address', async () => {
    const agent = a.getMdnsAgent();
    expect(agent).toBeTruthy();
    agent!.start();
    await agent!.whenReady();

    const wire = observeWire(a);
    expect(agent!.announce()).toBe(true);

    const toGroup = wire.filter((d) => d.destinationIP === MDNS_IPV6_GROUP);
    expect(toGroup.length).toBeGreaterThan(0);
    expect(toGroup.every((d) => d.destinationPort === MDNS_PORT)).toBe(true);
    // RFC 2464 §7: the low 32 bits of the group.
    expect(new Set(toGroup.map((d) => d.dstMAC))).toEqual(new Set(['33:33:00:00:00:fb']));
  });
});

describe('LLMNR sends on ff02::1:3', () => {
  it('a question leaves for the v6 group', async () => {
    const agent = a.getLlmnrAgent();
    expect(agent).toBeTruthy();
    agent!.start();

    const wire = observeWire(a);
    await agent!.resolve('beta');

    const toGroup = wire.filter((d) => d.destinationIP === LLMNR_IPV6_GROUP);
    expect(toGroup.length).toBeGreaterThan(0);
    expect(toGroup.every((d) => d.destinationPort === LLMNR_PORT)).toBe(true);
    expect(new Set(toGroup.map((d) => d.dstMAC))).toEqual(new Set(['33:33:00:01:00:03']));
  });
});

describe('what the packet carries is of use', () => {
  it('LLMNR answers an IPv6 address to an AAAA question', async () => {
    const target = b.getLlmnrAgent();
    expect(target).toBeTruthy();
    target!.start();
    const asker = a.getLlmnrAgent();
    asker!.start();

    const addresses = await asker!.resolveAaaa('beta');
    expect(addresses).toContain('2001:db8::2');
  });

  it('the link-local address is never advertised', async () => {
    const target = b.getLlmnrAgent();
    target!.start();
    const asker = a.getLlmnrAgent();
    asker!.start();

    const addresses = await asker!.resolveAaaa('beta');
    // An empty list would satisfy the next line while proving nothing.
    expect(addresses.length).toBeGreaterThan(0);
    // It is ambiguous off its link and the record carries no zone index.
    expect(addresses.some((ip) => ip.toLowerCase().startsWith('fe80'))).toBe(false);
  });
});

describe('no regression', () => {
  it('LLMNR IPv4 resolution still works', async () => {
    a.getPort('eth0')!.configureIP(
      new (await import('@/network/core/types')).IPAddress('10.0.0.1'),
      new (await import('@/network/core/types')).SubnetMask('255.255.255.0'));
    b.getPort('eth0')!.configureIP(
      new (await import('@/network/core/types')).IPAddress('10.0.0.2'),
      new (await import('@/network/core/types')).SubnetMask('255.255.255.0'));

    b.getLlmnrAgent()!.start();
    a.getLlmnrAgent()!.start();
    const addresses = await a.getLlmnrAgent()!.resolve('beta');
    expect(addresses).toContain('10.0.0.2');
  });
});
