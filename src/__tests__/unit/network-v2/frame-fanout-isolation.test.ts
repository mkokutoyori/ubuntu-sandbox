/**
 * Ethernet FCS + shared-reference fan-out (rapport 04, item #45).
 *
 * FCS: there's no byte-level frame encoding to corrupt, so a bare `fcs`
 * field would always validate — pure decoration. Instead, `Cable` gains a
 * `corruptionRate` knob mirroring the existing `packetLossRate` one: a
 * "corrupted" frame never reaches the receiver's handleFrame() (same
 * observable effect as a real NIC silently discarding a bad-FCS frame
 * before the driver sees it), tracked separately from generic loss and
 * wired into the previously-dead `Port.errorsIn` counter.
 *
 * Shared reference: Cable/Port frame delivery is (and stays) same-object
 * by design — `hardware.test.ts` asserts that identity for the single-hop
 * case. The real gap was fan-out call sites (Hub flood, Switch flood/
 * mirror, Router multicast replication) handing the SAME object to
 * multiple destinations instead of a fresh one per destination, latent
 * because nothing currently mutates post-handoff — but a landmine for the
 * next feature that does. These tests assert distinct object identity
 * per destination without touching Cable/Port's single-hop contract.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import { Hub } from '@/network/devices/Hub';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  nextIPv4Id, computeIPv4Checksum, ETHERTYPE_IPV4, IP_PROTO_UDP,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { ipv4MulticastToMac } from '@/network/igmp/types';

function makeFrame(srcMAC?: MACAddress, dstMAC?: MACAddress): EthernetFrame {
  return {
    srcMAC: srcMAC || MACAddress.generate(),
    dstMAC: dstMAC || MACAddress.generate(),
    etherType: ETHERTYPE_IPV4,
    payload: { type: 'test' },
  };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('Cable — simulated FCS/CRC corruption', () => {
  it('defaults to 0% corruption', () => {
    expect(new Cable('c1').getCorruptionRate()).toBe(0);
  });

  it('rejects an out-of-range corruption rate', () => {
    const cable = new Cable('c1');
    expect(() => cable.setCorruptionRate(-0.1)).toThrow();
    expect(() => cable.setCorruptionRate(1.5)).toThrow();
  });

  it('100% corruption drops every frame and increments the receiver errorsIn counter, distinct from framesLost', () => {
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    const cable = new Cable('c1');
    cable.connect(portA, portB);
    cable.setCorruptionRate(1.0);

    let received = false;
    portB.onFrame(() => { received = true; });

    const result = cable.transmit(makeFrame(), portA);

    expect(result).toBe(false);
    expect(received).toBe(false);
    expect(portB.getCounters().errorsIn).toBe(1);
    const stats = cable.getStats();
    expect(stats.framesCorrupted).toBe(1);
    expect(stats.framesLost).toBe(0);
  });

  it('0% corruption never blocks delivery', () => {
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    const cable = new Cable('c1');
    cable.connect(portA, portB);

    let receivedCount = 0;
    portB.onFrame(() => { receivedCount++; });
    for (let i = 0; i < 20; i++) cable.transmit(makeFrame(), portA);

    expect(receivedCount).toBe(20);
    expect(cable.getStats().framesCorrupted).toBe(0);
    expect(portB.getCounters().errorsIn).toBe(0);
  });

  it('getInfo() reports the corruption rate', () => {
    const cable = new Cable('c1');
    cable.setCorruptionRate(0.03);
    expect(cable.getInfo().corruptionRate).toBe(0.03);
  });
});

describe('Fan-out delivers a distinct frame object per destination', () => {
  it('Hub floods a fresh object to each port, not the same reference', () => {
    const hub = new Hub('HUB', 3);
    const src = new Port('eth0');
    const rcv1 = new Port('eth0');
    const rcv2 = new Port('eth0');
    new Cable('a').connect(hub.getPort('eth0')!, src);
    new Cable('b').connect(hub.getPort('eth1')!, rcv1);
    new Cable('c').connect(hub.getPort('eth2')!, rcv2);

    let f1: EthernetFrame | null = null;
    let f2: EthernetFrame | null = null;
    rcv1.onFrame((_n, f) => { f1 = f; });
    rcv2.onFrame((_n, f) => { f2 = f; });

    src.sendFrame(makeFrame(src.getMAC(), MACAddress.broadcast()));

    expect(f1).not.toBeNull();
    expect(f2).not.toBeNull();
    expect(f1).not.toBe(f2);
  });

  it('Switch flood gives each access port its own untagged frame object', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const src = new Port('eth0');
    const rcv1 = new Port('eth0');
    const rcv2 = new Port('eth0');
    new Cable('a').connect(sw.getPort('FastEthernet0/1')!, src);
    new Cable('b').connect(sw.getPort('FastEthernet0/2')!, rcv1);
    new Cable('c').connect(sw.getPort('FastEthernet0/3')!, rcv2);

    let f1: EthernetFrame | null = null;
    let f2: EthernetFrame | null = null;
    rcv1.onFrame((_n, f) => { f1 = f; });
    rcv2.onFrame((_n, f) => { f2 = f; });

    // Unknown unicast destination — floods to every access port on VLAN 1.
    src.sendFrame(makeFrame(src.getMAC(), MACAddress.generate()));

    expect(f1).not.toBeNull();
    expect(f2).not.toBeNull();
    expect(f1).not.toBe(f2);
  });

  it('port mirroring delivers a distinct object to the SPAN destination than to the real egress port', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const src = new Port('eth0');
    const dst = new Port('eth0');
    const spanDst = new Port('eth0');
    new Cable('a').connect(sw.getPort('FastEthernet0/1')!, src);
    new Cable('b').connect(sw.getPort('FastEthernet0/2')!, dst);
    new Cable('c').connect(sw.getPort('FastEthernet0/3')!, spanDst);

    // Learn dst's MAC so the next frame is unicast-forwarded, not flooded.
    dst.sendFrame(makeFrame(dst.getMAC(), src.getMAC()));

    sw.configureMirrorSource(1, 'FastEthernet0/1', 'both');
    sw.configureMirrorDestination(1, 'FastEthernet0/3');

    let realFrame: EthernetFrame | null = null;
    let mirrorFrame: EthernetFrame | null = null;
    dst.onFrame((_n, f) => { realFrame = f; });
    spanDst.onFrame((_n, f) => { mirrorFrame = f; });

    src.sendFrame(makeFrame(src.getMAC(), dst.getMAC()));

    expect(realFrame).not.toBeNull();
    expect(mirrorFrame).not.toBeNull();
    expect(realFrame).not.toBe(mirrorFrame);
  });
});

describe('Router multicast replication gives each OIF its own packet object', () => {
  it('two receivers on different OIFs get distinct IPv4Packet objects for the same datagram', () => {
    const r1 = new CiscoRouter('router-cisco', 'R1');
    const src = new CiscoSwitch('switch-cisco', 'SRC', 4);
    const rcv1 = new CiscoSwitch('switch-cisco', 'RCV1', 4);
    const rcv2 = new CiscoSwitch('switch-cisco', 'RCV2', 4);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, src.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r1.getPort('GigabitEthernet0/1')!, rcv1.getPort('FastEthernet0/1')!);
    new Cable('c').connect(r1.getPort('GigabitEthernet0/2')!, rcv2.getPort('FastEthernet0/1')!);
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/2', new IPAddress('192.168.2.1'), new SubnetMask('255.255.255.0'));
    r1.getPimAgent().joinGroup('239.5.5.5', 'GigabitEthernet0/1');
    r1.getPimAgent().joinGroup('239.5.5.5', 'GigabitEthernet0/2');

    const received: Array<{ deviceId: string; ip: IPv4Packet }> = [];
    for (const receiver of [rcv1, rcv2]) {
      receiver.attachCapture(({ direction, frame }) => {
        if (direction !== 'in') return;
        const ip = frame.payload as IPv4Packet | undefined;
        if (ip?.type === 'ipv4' && ip.protocol === IP_PROTO_UDP) {
          received.push({ deviceId: receiver.getId(), ip });
        }
      }, 'FastEthernet0/1');
    }

    const udp: UDPPacket = { type: 'udp', sourcePort: 1234, destinationPort: 5000, length: 8, checksum: 0 };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 28,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 4, protocol: IP_PROTO_UDP, headerChecksum: 0,
      sourceIP: new IPAddress('10.0.0.50'), destinationIP: new IPAddress('239.5.5.5'),
      payload: udp,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    src.getPort('FastEthernet0/1')!.sendFrame({
      srcMAC: src.getPort('FastEthernet0/1')!.getMAC(),
      dstMAC: new MACAddress(ipv4MulticastToMac('239.5.5.5')),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    });

    expect(received.length).toBe(2);
    expect(received[0].ip).not.toBe(received[1].ip);
  });
});
