/**
 * No shared bus — a machine observes its OWN interfaces, and only those.
 *
 * Written BLIND, before `src/network/hardware/PortTap.ts` exists.
 *
 * WHY THIS SHAPE. On a real machine, a capture attaches to a network
 * interface OF THAT MACHINE: AF_PACKET binds an interface index, libpcap
 * opens a device by name. There is no object anywhere that lets one host
 * read another host's frames — the only way to see a neighbour's traffic
 * is to be on its collision domain and receive the frame yourself.
 *
 * The global `EventBus` broke that: every machine's port published into
 * ONE process-wide object, and anything could read anything. The tap
 * replaces it with the real rule, and the rule is STRUCTURAL rather than
 * a matter of discipline: a tap is attached to a Port, and a Port
 * belongs to exactly one machine, so there is no expressible way to
 * observe a machine you do not own.
 *
 * Two directions, because a real capture sees both: a frame arriving on
 * the wire, and a frame this machine puts on it. Real pcap tags them
 * the same way (`tcpdump -Q in|out`).
 *
 * One thing that must NOT change: `Cable` delivers the SAME frame object
 * end to end, and CLAUDE.md records that this is deliberate. A tap that
 * cloned would break the identity assertion in `hardware.test.ts`, so
 * the tap hands out the very object that travels.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MACAddress, ETHERTYPE_IPV4, resetCounters, type EthernetFrame } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { TappedFrame } from '@/network/hardware/PortTap';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

function lab() {
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxPC('linux-pc', 'B', -150, 0);
  a.powerOn(); b.powerOn();
  new Cable('c1').connect(a.getPort('eth0')!, b.getPort('eth0')!);
  return { a, b };
}

function frameTo(destination: string, source: string): EthernetFrame {
  return {
    srcMAC: new MACAddress(source),
    dstMAC: new MACAddress(destination),
    etherType: ETHERTYPE_IPV4,
    payload: null,
  };
}

describe('a tap observes one interface of one machine', () => {
  it('a tap sees a frame arriving on its port', () => {
    const { a } = lab();
    const seen: TappedFrame[] = [];
    a.getPort('eth0')!.attachTap(f => seen.push(f));

    a.getPort('eth0')!.receiveFrame(frameTo('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:99'));

    expect(seen).toHaveLength(1);
    expect(seen[0].direction).toBe('in');
    expect(seen[0].iface).toBe('eth0');
  });

  it('a tap sees a frame this machine puts on the wire', () => {
    const { a } = lab();
    const seen: TappedFrame[] = [];
    a.getPort('eth0')!.attachTap(f => seen.push(f));

    a.getLinkLayer().send({
      iface: 'eth0',
      destination: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: null,
    });

    expect(seen.some(f => f.direction === 'out')).toBe(true);
  });

  it('the tap hands out the very frame that travels, not a copy', () => {
    const { a } = lab();
    const seen: TappedFrame[] = [];
    a.getPort('eth0')!.attachTap(f => seen.push(f));
    const sent = frameTo('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:99');

    a.getPort('eth0')!.receiveFrame(sent);

    expect(seen[0].frame).toBe(sent);
  });

  it('detaching stops delivery', () => {
    const { a } = lab();
    const seen: TappedFrame[] = [];
    const detach = a.getPort('eth0')!.attachTap(f => seen.push(f));

    detach();
    a.getPort('eth0')!.receiveFrame(frameTo('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:99'));

    expect(seen).toHaveLength(0);
  });

  it('a tap on one port ignores another port of the same machine', () => {
    const { a } = lab();
    const seen: TappedFrame[] = [];
    a.getPort('eth1')!.attachTap(f => seen.push(f));

    a.getPort('eth0')!.receiveFrame(frameTo('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:99'));

    expect(seen).toHaveLength(0);
  });
});

describe('a machine cannot observe another machine', () => {
  it('a capture on A never reports a frame B received', () => {
    const { a, b } = lab();
    const seenByA: TappedFrame[] = [];
    a.attachCapture(f => seenByA.push(f));

    b.getPort('eth1')!.receiveFrame(frameTo('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:99'));

    expect(seenByA).toHaveLength(0);
  });

  it('a machine capture covers every interface it owns', () => {
    const { a } = lab();
    const seen: TappedFrame[] = [];
    a.attachCapture(f => seen.push(f));

    a.getPort('eth0')!.receiveFrame(frameTo('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:99'));
    a.getPort('eth1')!.receiveFrame(frameTo('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:99'));

    expect(seen.map(f => f.iface).sort()).toEqual(['eth0', 'eth1']);
  });

  it('a machine capture can be narrowed to one interface', () => {
    const { a } = lab();
    const seen: TappedFrame[] = [];
    a.attachCapture(f => seen.push(f), 'eth0');

    a.getPort('eth0')!.receiveFrame(frameTo('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:99'));
    a.getPort('eth1')!.receiveFrame(frameTo('ff:ff:ff:ff:ff:ff', '02:00:00:00:00:99'));

    expect(seen.map(f => f.iface)).toEqual(['eth0']);
  });

  it('a frame really crossing the cable is seen by BOTH machines own taps', () => {
    const { a, b } = lab();
    const seenByA: TappedFrame[] = [];
    const seenByB: TappedFrame[] = [];
    a.attachCapture(f => seenByA.push(f));
    b.attachCapture(f => seenByB.push(f));

    a.getLinkLayer().send({
      iface: 'eth0',
      destination: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: null,
    });

    expect(seenByA.some(f => f.direction === 'out')).toBe(true);
    expect(seenByB.some(f => f.direction === 'in')).toBe(true);
  });
});
