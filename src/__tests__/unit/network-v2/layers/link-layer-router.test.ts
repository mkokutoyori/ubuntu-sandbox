/**
 * BRD-Modele-TCP-IP phase 1, migration step 2 — the router reads the rule.
 *
 * Written BLIND. `Router.handleFrame` carries the SAME enumeration as
 * `EndHost.handleFrame` did, written a second time:
 *
 *     const isIpv6Multicast = octets[0] === 0x33 && octets[1] === 0x33;
 *     const isIpv4Multicast = octets[0] === 0x01 && octets[1] === 0x00
 *                          && octets[2] === 0x5e;
 *
 * plus one thing a host does not have and which is NOT a defect:
 * `fhrpOwnsVirtualMac`. A router really does own extra unicast addresses
 * — the HSRP/VRRP/GLBP virtual MAC — exactly as a real NIC holds several
 * unicast filters. So the link layer must not merely be copied here: it
 * needs an extension point for additional local unicast addresses, and
 * the FHRP case is the witness that the extension point works.
 *
 * The probe technique is the one of the host step: an ARP request FOR
 * THE ROUTER'S OWN ADDRESS, sent to a destination the old enumeration
 * does not know, and the ARP reply on the wire as the observable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  MACAddress, IPAddress, ETHERTYPE_ARP, resetCounters,
  type ARPPacket, type EthernetFrame,
} from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getDefaultEventBus } from '@/events/EventBus';

const STP_GROUP = '01:80:c2:00:00:00';
const CDP_GROUP = '01:00:0c:cc:cc:cc';
const HSRP_V1_VIRTUAL_MAC = '00:00:0c:07:ac:01';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function lab() {
  const router = new CiscoRouter('R1', 0, 0);
  const peer = new LinuxPC('linux-pc', 'PC', -150, 0);
  peer.powerOn();
  new Cable('c1').connect(peer.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
  for (const line of [
    'enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
  ]) await router.executeCommand(line);
  return { router, peer };
}

function arpFor(peer: LinuxPC, target: string, destination: string): EthernetFrame {
  const arp: ARPPacket = {
    type: 'arp',
    operation: 'request',
    senderMAC: peer.getPort('eth0')!.getMAC(),
    senderIP: new IPAddress('10.0.0.9'),
    targetMAC: new MACAddress('00:00:00:00:00:00'),
    targetIP: new IPAddress(target),
  };
  return {
    srcMAC: peer.getPort('eth0')!.getMAC(),
    dstMAC: new MACAddress(destination),
    etherType: ETHERTYPE_ARP,
    payload: arp,
  };
}

function repliesTo(
  router: CiscoRouter, peer: LinuxPC, destination: string, target = '10.0.0.1',
): number {
  let replies = 0;
  getDefaultEventBus().subscribe('port.frame.received', (event) => {
    const { frame } = event.payload as { frame: EthernetFrame };
    if (frame.etherType !== ETHERTYPE_ARP) return;
    if ((frame.payload as ARPPacket).operation === 'reply') replies++;
  });
  router.getPort('GigabitEthernet0/0')!.receiveFrame(arpFor(peer, target, destination));
  return replies;
}

describe('a router classifies a frame with the same rule as a host', () => {
  it('TEMOIN: a broadcast ARP request is answered', async () => {
    const { router, peer } = await lab();

    expect(repliesTo(router, peer, 'ff:ff:ff:ff:ff:ff')).toBe(1);
  });

  it('TEMOIN: an ARP request to the port own address is answered', async () => {
    const { router, peer } = await lab();
    const own = router.getPort('GigabitEthernet0/0')!.getMAC().toString();

    expect(repliesTo(router, peer, own)).toBe(1);
  });

  it('a frame to the STP group reaches the protocol', async () => {
    const { router, peer } = await lab();

    expect(repliesTo(router, peer, STP_GROUP)).toBe(1);
  });

  it('a frame to the CDP group reaches the protocol', async () => {
    const { router, peer } = await lab();

    expect(repliesTo(router, peer, CDP_GROUP)).toBe(1);
  });

  it('a frame for another host is dropped', async () => {
    const { router, peer } = await lab();

    expect(repliesTo(router, peer, '02:00:00:00:00:99')).toBe(0);
  });
});

describe('a router owns more than one unicast address', () => {
  it('the HSRP virtual MAC is still accepted', async () => {
    const { router, peer } = await lab();
    for (const line of [
      'configure terminal', 'interface GigabitEthernet0/0',
      'standby 1 ip 10.0.0.254', 'end',
    ]) await router.executeCommand(line);

    expect(repliesTo(router, peer, HSRP_V1_VIRTUAL_MAC, '10.0.0.254')).toBe(1);
  });

  it('an unrelated unicast address is still not ours', async () => {
    const { router, peer } = await lab();
    for (const line of [
      'configure terminal', 'interface GigabitEthernet0/0',
      'standby 1 ip 10.0.0.254', 'end',
    ]) await router.executeCommand(line);

    expect(repliesTo(router, peer, '00:00:0c:07:ac:63', '10.0.0.254')).toBe(0);
  });
});

describe('the classification lives in one place', () => {
  it('Router no longer enumerates multicast prefixes', () => {
    const source = readFileSync('src/network/devices/Router.ts', 'utf8');

    expect(source).not.toMatch(/octets\[0\] === 0x33/);
    expect(source).not.toMatch(/octets\[2\] === 0x5e/);
  });

  it('Router reads the link layer', () => {
    const source = readFileSync('src/network/devices/Router.ts', 'utf8');

    expect(source).toContain('getLinkLayer()');
  });

  it('no device file enumerates a multicast MAC prefix', () => {
    const offenders = readdirSync('src/network/devices')
      .filter(name => name.endsWith('.ts'))
      .filter(name => {
        const source = readFileSync(`src/network/devices/${name}`, 'utf8');
        return /octets\[0\] === 0x33/.test(source)
          || /octets\[2\] === 0x5e/.test(source);
      });

    expect(offenders).toEqual([]);
  });

  it('no device file derives the I/G bit by hand', () => {
    const offenders = readdirSync('src/network/devices')
      .filter(name => name.endsWith('.ts'))
      .filter(name => /Octets\[0\] & 0x01/.test(
        readFileSync(`src/network/devices/${name}`, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
