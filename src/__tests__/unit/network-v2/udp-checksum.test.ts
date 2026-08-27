/**
 * UDP checksum (RFC 768) — `computeUdpChecksum`/`verifyUdpChecksum` already
 * existed (shared with TCP's L4 checksum, `src/network/tcp/types.ts`) but
 * were only ever used cosmetically by tcpdump's "[bad udp cksum]"
 * annotation — every `UDPPacket` a device actually built or accepted
 * carried a hardcoded `checksum: 0`, and nothing ever verified one on
 * receipt. `sendUdpDatagram` now stamps a real checksum, and both
 * `EndHost.deliverUDP` and `Router.handleLocalDelivery` verify it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import {
  IPAddress, SubnetMask, MACAddress, resetCounters, createIPv4Packet,
  IP_PROTO_UDP, ETHERTYPE_IPV4, type UDPPacket, type EthernetFrame,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { computeUdpChecksum, verifyUdpChecksum } from '@/network/layers/transport/UdpChecksum';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('computeUdpChecksum / verifyUdpChecksum (RFC 768)', () => {
  const udp = () => ({ sourcePort: 1000, destinationPort: 2000, payload: 'hello' });

  it('computes a non-zero checksum over the IPv4 pseudo-header', () => {
    const cs = computeUdpChecksum(udp(), '10.0.0.1', '10.0.0.2');
    expect(cs).toBeGreaterThan(0);
    expect(cs).toBeLessThanOrEqual(0xffff);
  });

  it('round-trips: a datagram stamped with its checksum verifies', () => {
    const d = { ...udp(), checksum: 0 };
    d.checksum = computeUdpChecksum(d, '10.0.0.1', '10.0.0.2');
    expect(verifyUdpChecksum(d, '10.0.0.1', '10.0.0.2')).toBe(true);
  });

  it('fails verification when the payload is tampered', () => {
    const d = { ...udp(), checksum: 0 };
    d.checksum = computeUdpChecksum(d, '10.0.0.1', '10.0.0.2');
    expect(verifyUdpChecksum({ ...d, payload: 'hellO' }, '10.0.0.1', '10.0.0.2')).toBe(false);
  });

  it('fails verification when the source address is spoofed', () => {
    const d = { ...udp(), checksum: 0 };
    d.checksum = computeUdpChecksum(d, '10.0.0.1', '10.0.0.2');
    expect(verifyUdpChecksum(d, '10.0.0.99', '10.0.0.2')).toBe(false);
  });

  it('treats checksum 0 as "not computed" and always accepts (RFC 768 IPv4 opt-out)', () => {
    const d = { ...udp(), checksum: 0 };
    expect(verifyUdpChecksum(d, '10.0.0.1', '10.0.0.2')).toBe(true);
    expect(verifyUdpChecksum(d, '10.0.0.99', '10.0.0.2')).toBe(true);
  });
});

describe('EndHost UDP checksum over the real wire', () => {
  function buildPair() {
    const src = new LinuxPC('linux-pc', 'PC1');
    const dst = new LinuxPC('linux-pc', 'PC2');
    src.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    dst.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(src.getPort('eth0')!, dst.getPort('eth0')!);
    return { src, dst };
  }

  it('sendUdpDatagram stamps a real checksum that verifies on arrival', () => {
    const { src, dst } = buildPair();
    const received: { checksum: number; srcIp: string; dstIp: string }[] = [];
    dst.udpBind(9000, (d) => received.push({
      checksum: d.udp.checksum, srcIp: d.sourceIP.toString(), dstIp: d.destinationIP.toString(),
    }));

    src.sendUdpDatagram(new IPAddress('10.0.0.2'), 9000, 5000, 'hello', 5);

    expect(received).toHaveLength(1);
    expect(received[0].checksum).not.toBe(0);
    expect(verifyUdpChecksum(
      { sourcePort: 5000, destinationPort: 9000, payload: 'hello', checksum: received[0].checksum },
      received[0].srcIp, received[0].dstIp,
    )).toBe(true);
  });

  it('drops a datagram with a mismatched checksum instead of delivering it', () => {
    const { dst } = buildPair();
    const dstPort = dst.getPort('eth0')!;
    let deliveries = 0;
    dst.udpBind(9001, () => { deliveries++; });

    const udp: UDPPacket = {
      type: 'udp', sourcePort: 5001, destinationPort: 9001, length: 8 + 5, checksum: 0xdead, payload: 'hello',
    };
    const ipPkt = createIPv4Packet(new IPAddress('10.0.0.9'), new IPAddress('10.0.0.2'), IP_PROTO_UDP, 64, udp, udp.length);
    const frame: EthernetFrame = {
      srcMAC: new MACAddress('02:00:00:00:00:99'),
      dstMAC: dstPort.getMAC(),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    };

    dstPort.receiveFrame(frame);

    expect(deliveries).toBe(0);
    const dropLog = Logger.getLogsBySource(dst.id).find((l) => l.event === 'udp:checksum-fail');
    expect(dropLog).toBeTruthy();
  });

  it('still delivers legacy checksum:0 traffic unaffected (internal protocol agents)', () => {
    const { dst } = buildPair();
    const dstPort = dst.getPort('eth0')!;
    let deliveries = 0;
    dst.udpBind(9002, () => { deliveries++; });

    const udp: UDPPacket = {
      type: 'udp', sourcePort: 5002, destinationPort: 9002, length: 8 + 5, checksum: 0, payload: 'hello',
    };
    const ipPkt = createIPv4Packet(new IPAddress('10.0.0.9'), new IPAddress('10.0.0.2'), IP_PROTO_UDP, 64, udp, udp.length);
    dstPort.receiveFrame({
      srcMAC: new MACAddress('02:00:00:00:00:99'),
      dstMAC: dstPort.getMAC(),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    });

    expect(deliveries).toBe(1);
  });
});

describe('Router UDP checksum on self-destined control-plane traffic', () => {
  it('drops a corrupted UDP datagram addressed to the router itself', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const r1 = new CiscoRouter('R1', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
    new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
    new Cable('c2').connect(r1.getPorts()[0], sw.getPorts()[1]);
    for (const cmd of [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end',
    ]) await r1.executeCommand(cmd);

    const r1Port = r1.getPorts()[0];
    const udp: UDPPacket = {
      type: 'udp', sourcePort: 520, destinationPort: 520, length: 8 + 4, checksum: 0xbeef, payload: 'ripd',
    };
    const ipPkt = createIPv4Packet(new IPAddress('10.0.0.9'), new IPAddress('10.0.0.1'), IP_PROTO_UDP, 64, udp, udp.length);
    r1Port.receiveFrame({
      srcMAC: new MACAddress('02:00:00:00:00:98'),
      dstMAC: r1Port.getMAC(),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    });

    const dropLog = Logger.getLogsBySource(r1.id).find((l) => l.event === 'udp:checksum-fail');
    expect(dropLog).toBeTruthy();
  });
});
