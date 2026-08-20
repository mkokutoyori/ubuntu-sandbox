/**
 * The IPv6 multicast send path.
 *
 * It did not exist, and this repo had already hit the wall twice
 * without naming it: mDNS gave up its IPv6 groups "for want of a send
 * path to any group at all", and OSPFv3 formed its adjacencies out of
 * band for the same reason.
 *
 * `sendUdpDatagram6` resolved the next hop by NDP, which can never
 * succeed for `ff02::5`: a group has no neighbour to solicit. What was
 * missing was not the address conversion — `toMulticastMAC()`
 * (RFC 2464 §7) had always been there, with no caller.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Address } from '@/network/core/types';

let a: LinuxPC;
let b: LinuxPC;
/** What B actually received on the listening port. */
let received: string[];

function listen(host: LinuxPC, port: number): void {
  (host as unknown as { udpListeners: Map<number, (d: unknown) => void> })
    .udpListeners.set(port, (d) => {
      const dgram = d as { udp?: { payload?: unknown } };
      received.push(String(dgram.udp?.payload));
    });
}

function cfg(host: LinuxPC, iface: string, address: string): void {
  (host as unknown as {
    configureIPv6Interface(i: string, a: IPv6Address, p: number): boolean;
  }).configureIPv6Interface(iface, new IPv6Address(address), 64);
}

beforeEach(() => {
  received = [];
  a = new LinuxPC('A');
  b = new LinuxPC('B');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  a.powerOn(); b.powerOn(); sw.powerOn();
  new Cable('x').connect(a.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('y').connect(b.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  // `configureIPv6Interface`, not `Port.configureIPv6`: it is the path
  // `ip -6 addr add` takes, and the only one that installs the connected
  // route unicast needs.
  cfg(a, 'eth0', '2001:db8::1');
  cfg(b, 'eth0', '2001:db8::2');
  listen(b, 4242);
});

const h = (d: LinuxPC) => d as unknown as {
  joinIPv6Group(i: string, g: string): boolean;
  leaveIPv6Group(i: string, g: string): boolean;
  listIPv6Groups(i?: string): Array<{ iface: string; group: string }>;
  sendUdpDatagram6(dst: IPv6Address, dp: number, sp: number, p: unknown, n: number): boolean;
};

describe('a datagram reaches an IPv6 group', () => {
  it('the joined host receives it', () => {
    expect(h(b).joinIPv6Group('eth0', 'ff02::99')).toBe(true);
    expect(h(a).sendUdpDatagram6(new IPv6Address('ff02::99'), 4242, 5000, 'coucou', 6)).toBe(true);
    expect(received).toEqual(['coucou']);
  });

  it('a host that has NOT joined does not receive it', () => {
    // The guard: without it, "deliver everything" would pass the case
    // above with no filter in existence.
    expect(h(a).sendUdpDatagram6(new IPv6Address('ff02::77'), 4242, 5000, 'x', 1)).toBe(true);
    expect(received).toEqual([]);
  });

  it('leaving the group is enough to stop receiving', () => {
    h(b).joinIPv6Group('eth0', 'ff02::99');
    h(a).sendUdpDatagram6(new IPv6Address('ff02::99'), 4242, 5000, 'un', 2);
    expect(h(b).leaveIPv6Group('eth0', 'ff02::99')).toBe(true);
    h(a).sendUdpDatagram6(new IPv6Address('ff02::99'), 4242, 5000, 'deux', 4);
    expect(received).toEqual(['un']);
  });

  it('membership can be read back', () => {
    h(b).joinIPv6Group('eth0', 'ff02::99');
    // Not strict equality: the machine also belongs to the LLMNR and
    // mDNS groups, which systemd-resolved joins at boot.
    expect(h(b).listIPv6Groups()).toContainEqual({ iface: 'eth0', group: 'ff02::99' });
    expect(h(b).listIPv6Groups('eth1')).not.toContainEqual({ iface: 'eth1', group: 'ff02::99' });
  });

  it('a malformed group, or a unicast address, is refused', () => {
    expect(h(b).joinIPv6Group('eth0', 'pas-une-address')).toBe(false);
    // `2001:db8::2` is ITS address, and not a group.
    expect(h(b).joinIPv6Group('eth0', '2001:db8::2')).toBe(false);
  });

  it('an interface that does not exist is refused', () => {
    expect(h(b).joinIPv6Group('eth9', 'ff02::99')).toBe(false);
  });
});

describe('what tells a multicast send from an ordinary one', () => {
  it('IPv6 unicast still works', async () => {
    // No regression: the added path must not divert unicast, which does
    // have a route and a neighbour. The wait is the neighbour's — the
    // first packet to an unknown one leaves AFTER the NDP solicitation.
    listen(b, 4243);
    expect(h(a).sendUdpDatagram6(new IPv6Address('2001:db8::2'), 4243, 5000, 'direct', 6)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toEqual(['direct']);
  });

  it('the send succeeds with no neighbour to solicit', () => {
    // This was the defect: NDP cannot resolve a group, so the send
    // failed. Nobody listens here, and it must still happen.
    expect(h(a).sendUdpDatagram6(new IPv6Address('ff02::1'), 9999, 5000, 'x', 1)).toBe(true);
  });
});
