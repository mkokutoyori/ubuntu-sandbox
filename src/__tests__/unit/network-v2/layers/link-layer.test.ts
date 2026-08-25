/**
 * BRD-Modele-TCP-IP phase 1 — the link layer exists and carries the flag.
 *
 * Written BLIND, before a line of `src/network/layers/link/` exists: these
 * assertions describe what RFC 1122 and IEEE 802 require, not what the
 * repository currently does.
 *
 * NORMATIVE ANCHORS, quoted rather than remembered.
 *
 * RFC 1122 section 2.4: "The packet receive interface between the IP
 * layer and the link layer MUST include a flag to indicate whether the
 * incoming packet was addressed to a link-layer broadcast address."
 * That flag is decided in ONE place here, and only here.
 *
 * IEEE 802: "the individual/group (I/G) address bit, least significant
 * bit of octet 0" — 0 is an individual address, 1 is a group address;
 * the broadcast address is "a special, predefined group address of all
 * 1's". So group membership is a BIT, never a list of known multicast
 * MACs: 01:00:5e (IPv4), 33:33 (IPv6), 01:80:c2 (STP) and 01:00:0c
 * (CDP/VTP) must all classify without being enumerated anywhere.
 *
 * packet(7): "PACKET_HOST for a packet addressed to the local host,
 * PACKET_BROADCAST for a physical-layer broadcast packet,
 * PACKET_MULTICAST for a packet sent to a physical-layer multicast
 * address, PACKET_OTHERHOST for a packet to some other host that has
 * been caught by a device driver in promiscuous mode". Broadcast and
 * multicast are DISTINCT outcomes even though a broadcast address has
 * its I/G bit set — collapsing them would lose the RFC 1122 flag.
 *
 * PACKET_OUTGOING is deliberately absent: nothing in this simulator
 * loops a locally-originated frame back to a packet socket, so a value
 * nothing can produce would be decoration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  LinkLayer, classifyDestination, isBroadcastAddress, isGroupAddress,
  type LinkPacketType,
} from '@/network/layers/link/LinkLayer';
import { MACAddress, ETHERTYPE_IPV4, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const BROADCAST = 'ff:ff:ff:ff:ff:ff';
const OWN = '02:00:00:00:00:aa';
const OTHER = '02:00:00:00:00:bb';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

describe('the I/G bit decides group membership', () => {
  it('an individual address is not a group address', () => {
    expect(isGroupAddress(new MACAddress(OWN))).toBe(false);
    expect(isGroupAddress(new MACAddress('00:11:22:33:44:55'))).toBe(false);
  });

  it('every real multicast prefix is a group address, none enumerated', () => {
    for (const mac of [
      '01:00:5e:00:00:01', '33:33:00:00:00:01',
      '01:80:c2:00:00:00', '01:00:0c:cc:cc:cc',
    ]) expect(isGroupAddress(new MACAddress(mac))).toBe(true);
  });

  it('the broadcast address is a group address with every bit set', () => {
    expect(isGroupAddress(new MACAddress(BROADCAST))).toBe(true);
    expect(isBroadcastAddress(new MACAddress(BROADCAST))).toBe(true);
  });

  it('a multicast address is not the broadcast address', () => {
    expect(isBroadcastAddress(new MACAddress('01:00:5e:00:00:01'))).toBe(false);
  });
});

describe('a received frame is classified once, the packet(7) way', () => {
  const classify = (destination: string): LinkPacketType =>
    classifyDestination(new MACAddress(destination), new MACAddress(OWN));

  it('a frame for us is host', () => {
    expect(classify(OWN)).toBe('host');
  });

  it('a broadcast frame is broadcast, never multicast', () => {
    expect(classify(BROADCAST)).toBe('broadcast');
  });

  it('a multicast frame is multicast', () => {
    expect(classify('01:00:5e:00:00:fb')).toBe('multicast');
  });

  it('a frame for someone else is otherhost', () => {
    expect(classify(OTHER)).toBe('otherhost');
  });

  it('the comparison ignores case and separators', () => {
    expect(classifyDestination(
      new MACAddress('02:00:00:00:00:AA'), new MACAddress(OWN))).toBe('host');
  });
});

describe('the delivery carries the RFC 1122 flag', () => {
  function labo() {
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    pc.powerOn();
    const peer = new LinuxPC('linux-pc', 'PEER', -150, 0);
    peer.powerOn();
    new Cable('c1').connect(peer.getPort('eth0')!, pc.getPort('eth0')!);
    return { pc, peer };
  }

  const frameTo = (destination: string, source: string) => ({
    srcMAC: new MACAddress(source),
    dstMAC: new MACAddress(destination),
    etherType: ETHERTYPE_IPV4,
    payload: null,
  });

  it('a device exposes its link layer', () => {
    const { pc } = labo();

    expect(pc.getLinkLayer()).toBeInstanceOf(LinkLayer);
  });

  it('a broadcast frame is delivered with wasLinkBroadcast true', () => {
    const { pc } = labo();
    const own = pc.getPort('eth0')!.getMAC().toString();

    const delivered = pc.getLinkLayer().deliver('eth0', frameTo(BROADCAST, own));

    expect(delivered).not.toBeNull();
    expect(delivered!.wasLinkBroadcast).toBe(true);
    expect(delivered!.wasLinkMulticast).toBe(false);
    expect(delivered!.packetType).toBe('broadcast');
  });

  it('a unicast frame for us is delivered without the flag', () => {
    const { pc } = labo();
    const own = pc.getPort('eth0')!.getMAC().toString();

    const delivered = pc.getLinkLayer().deliver('eth0', frameTo(own, OTHER));

    expect(delivered).not.toBeNull();
    expect(delivered!.wasLinkBroadcast).toBe(false);
    expect(delivered!.packetType).toBe('host');
  });

  it('a frame for another host is dropped unless the port is promiscuous', () => {
    const { pc } = labo();

    expect(pc.getLinkLayer().deliver('eth0', frameTo(OTHER, OWN))).toBeNull();

    pc.getPort('eth0')!.setPromiscuous(true);
    const seen = pc.getLinkLayer().deliver('eth0', frameTo(OTHER, OWN));

    expect(seen).not.toBeNull();
    expect(seen!.packetType).toBe('otherhost');
  });

  it('a frame on an interface this device does not have is dropped', () => {
    const { pc } = labo();

    expect(pc.getLinkLayer().deliver('eth99', frameTo(BROADCAST, OWN))).toBeNull();
  });
});

describe('sending goes through the layer, not through a hand-built frame', () => {
  function labo() {
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    pc.powerOn();
    const peer = new LinuxPC('linux-pc', 'PEER', -150, 0);
    peer.powerOn();
    new Cable('c1').connect(peer.getPort('eth0')!, pc.getPort('eth0')!);
    return { pc, peer };
  }

  it('the source address is the port own address, the caller never supplies it', () => {
    const { pc, peer } = labo();
    const seen: string[] = [];
    peer.getBus().subscribe('port.frame.received', (event) => {
      seen.push((event.payload as { frame: { srcMAC: MACAddress } }).frame.srcMAC.toString());
    });

    const sent = pc.getLinkLayer().send({
      iface: 'eth0',
      destination: new MACAddress(BROADCAST),
      etherType: ETHERTYPE_IPV4,
      payload: null,
    });

    expect(sent).toBe(true);
    expect(seen).toEqual([pc.getPort('eth0')!.getMAC().toString()]);
  });

  it('sending on an unknown interface is refused', () => {
    const { pc } = labo();

    expect(pc.getLinkLayer().send({
      iface: 'eth99',
      destination: new MACAddress(BROADCAST),
      etherType: ETHERTYPE_IPV4,
      payload: null,
    })).toBe(false);
  });

  it('sending on a down interface is refused', () => {
    const { pc } = labo();
    pc.getPort('eth0')!.setAdminDown(true);

    expect(pc.getLinkLayer().send({
      iface: 'eth0',
      destination: new MACAddress(BROADCAST),
      etherType: ETHERTYPE_IPV4,
      payload: null,
    })).toBe(false);
  });

  it('sending from a powered-off device is refused', () => {
    const { pc } = labo();
    pc.powerOff();

    expect(pc.getLinkLayer().send({
      iface: 'eth0',
      destination: new MACAddress(BROADCAST),
      etherType: ETHERTYPE_IPV4,
      payload: null,
    })).toBe(false);
  });
});
