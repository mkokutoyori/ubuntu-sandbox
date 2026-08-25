/**
 * BRD-Modele-TCP-IP phase 1, migration step — the host reads the rule.
 *
 * Written BLIND against the exit criterion of the BRD: "wasLinkBroadcast
 * est decide en un seul lieu, et les handleFrame ne le recalculent plus".
 *
 * MEASURED STARTING POINT. `EndHost.handleFrame` does not read the I/G
 * bit; it ENUMERATES two prefixes:
 *
 *     const isMulticast = octets[0] === 0x33 && octets[1] === 0x33;
 *     const isIpv4Multicast = octets[0] === 0x01 && octets[1] === 0x00
 *                          && octets[2] === 0x5e;
 *
 * The file itself carries the proof that this was already known to be
 * wrong: LLDP needed a hand-written early exit, whose comment says the
 * frame "n'est ni broadcast ni l'un des deux prefixes multicast IP
 * reconnus plus bas : sans cette sortie anticipee le filtre L2 jetterait
 * la trame". One exception was written for one protocol; every other L2
 * group address — STP 01:80:c2, CDP/VTP 01:00:0c, LACP 01:80:c2:00:00:02
 * — is still dropped by a host.
 *
 * And `port.isPromiscuous()` is consulted NOWHERE in that filter, on a
 * machine where `ip link set eth0 promisc on` really sets the flag.
 *
 * OBSERVABILITY, and why the probe looks the way it does. A packet
 * capture subscribes to `port.frame.received`, which fires BELOW this
 * filter, so a capture cannot tell the two behaviours apart. The only
 * observable consequence of the filter is whether the frame reaches a
 * protocol — so the probe sends an ARP request FOR THIS HOST'S OWN
 * ADDRESS to a group destination the old enumeration does not know, and
 * watches for the ARP reply on the wire. No reply means the filter
 * dropped it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MACAddress, IPAddress, SubnetMask, ETHERTYPE_ARP, resetCounters,
  type ARPPacket, type EthernetFrame,
} from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getDefaultEventBus } from '@/events/EventBus';

const STP_GROUP = '01:80:c2:00:00:00';
const CDP_GROUP = '01:00:0c:cc:cc:cc';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

function lab() {
  const host = new LinuxPC('linux-pc', 'HOST', 0, 0);
  const peer = new LinuxPC('linux-pc', 'PEER', -150, 0);
  host.powerOn(); peer.powerOn();
  new Cable('c1').connect(peer.getPort('eth0')!, host.getPort('eth0')!);
  host.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  peer.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  return { host, peer };
}

function arpRequestFor(peer: LinuxPC, destination: string): EthernetFrame {
  const arp: ARPPacket = {
    type: 'arp',
    operation: 'request',
    senderMAC: peer.getPort('eth0')!.getMAC(),
    senderIP: new IPAddress('10.0.0.2'),
    targetMAC: new MACAddress('00:00:00:00:00:00'),
    targetIP: new IPAddress('10.0.0.1'),
  };
  return {
    srcMAC: peer.getPort('eth0')!.getMAC(),
    dstMAC: new MACAddress(destination),
    etherType: ETHERTYPE_ARP,
    payload: arp,
  };
}

function repliesTo(host: LinuxPC, peer: LinuxPC, destination: string): number {
  let replies = 0;
  getDefaultEventBus().subscribe('port.frame.received', (event) => {
    const { frame } = event.payload as { frame: EthernetFrame };
    if (frame.etherType !== ETHERTYPE_ARP) return;
    if ((frame.payload as ARPPacket).operation === 'reply') replies++;
  });
  host.getPort('eth0')!.receiveFrame(arpRequestFor(peer, destination));
  return replies;
}

describe('a group address is a group address, whoever defined it', () => {
  it('TEMOIN: a broadcast ARP request is answered', () => {
    const { host, peer } = lab();

    expect(repliesTo(host, peer, 'ff:ff:ff:ff:ff:ff')).toBe(1);
  });

  it('TEMOIN: an ARP request to our own address is answered', () => {
    const { host, peer } = lab();

    expect(repliesTo(host, peer, host.getPort('eth0')!.getMAC().toString())).toBe(1);
  });

  it('a frame to the STP group reaches the protocol', () => {
    const { host, peer } = lab();

    expect(repliesTo(host, peer, STP_GROUP)).toBe(1);
  });

  it('a frame to the CDP group reaches the protocol', () => {
    const { host, peer } = lab();

    expect(repliesTo(host, peer, CDP_GROUP)).toBe(1);
  });

  it('a frame for another host is still dropped when not promiscuous', () => {
    const { host, peer } = lab();

    expect(repliesTo(host, peer, '02:00:00:00:00:99')).toBe(0);
  });

  it('a promiscuous interface passes another host frame up', () => {
    const { host, peer } = lab();
    host.getPort('eth0')!.setPromiscuous(true);

    expect(repliesTo(host, peer, '02:00:00:00:00:99')).toBe(1);
  });
});

describe('the classification lives in one place', () => {
  it('EndHost no longer enumerates multicast prefixes', () => {
    const source = readFileSync('src/network/devices/EndHost.ts', 'utf8');

    expect(source).not.toContain('0x5e');
    expect(source).not.toMatch(/octets\[0\] === 0x33/);
  });

  it('EndHost reads the link layer', () => {
    const source = readFileSync('src/network/devices/EndHost.ts', 'utf8');

    expect(source).toContain('getLinkLayer()');
  });
});
