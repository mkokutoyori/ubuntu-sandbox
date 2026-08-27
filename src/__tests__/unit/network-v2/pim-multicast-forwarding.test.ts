/**
 * Real L3 multicast data forwarding (rapport 02 audit, item #43). PIM/IGMP
 * control-plane state was entirely real (genuine Hello/Join-Prune/membership
 * reports), but Router.ts treated the whole 224-239 range as always-local
 * and never forwarded: IGMP membership never reached PimAgent's OIL, and
 * nothing ever replicated data packets out that OIL either.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
  type IPv4Packet, type EthernetFrame, type UDPPacket,
  nextIPv4Id, computeIPv4Checksum, ETHERTYPE_IPV4, IP_PROTO_UDP,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { ipv4MulticastToMac, type IgmpPacket } from '@/network/igmp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function sendIgmpReport(hostPort: import('@/network/hardware/Port').Port, srcIp: string, group: string): void {
  const payload: IgmpPacket = {
    type: 'igmp', version: 2, messageType: 'v2-membership-report',
    maxRespTimeDs: 0, groupAddress: group, checksum: 0,
  };
  const ipPkt: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 6, tos: 0xc0, totalLength: 32,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
    ttl: 1, protocol: 2, headerChecksum: 0,
    sourceIP: new IPAddress(srcIp), destinationIP: new IPAddress(group),
    payload,
  };
  ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
  hostPort.sendFrame({
    srcMAC: hostPort.getMAC(), dstMAC: new MACAddress(ipv4MulticastToMac(group)),
    etherType: ETHERTYPE_IPV4, payload: ipPkt,
  });
}

function sendMulticastUdp(
  hostPort: import('@/network/hardware/Port').Port, srcIp: string, group: string,
  ttl = 4, destinationPort = 5000,
): void {
  const udp: UDPPacket = { type: 'udp', sourcePort: 12345, destinationPort, length: 8, checksum: 0 };
  const ipPkt: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 28,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
    ttl, protocol: IP_PROTO_UDP, headerChecksum: 0,
    sourceIP: new IPAddress(srcIp), destinationIP: new IPAddress(group),
    payload: udp,
  };
  ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
  hostPort.sendFrame({
    srcMAC: hostPort.getMAC(), dstMAC: new MACAddress(ipv4MulticastToMac(group)),
    etherType: ETHERTYPE_IPV4, payload: ipPkt,
  });
}

function topology() {
  const r1 = new CiscoRouter('router-cisco', 'R1');
  const src = new CiscoSwitch('switch-cisco', 'SRC', 4);
  const rcv = new CiscoSwitch('switch-cisco', 'RCV', 4);
  const other = new CiscoSwitch('switch-cisco', 'OTHER', 4);
  new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, src.getPort('FastEthernet0/1')!);
  new Cable('b').connect(r1.getPort('GigabitEthernet0/1')!, rcv.getPort('FastEthernet0/1')!);
  new Cable('c').connect(r1.getPort('GigabitEthernet0/2')!, other.getPort('FastEthernet0/1')!);
  r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  r1.configureInterface('GigabitEthernet0/1', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
  r1.configureInterface('GigabitEthernet0/2', new IPAddress('192.168.2.1'), new SubnetMask('255.255.255.0'));
  r1.getIgmpAgent().enableInterface('GigabitEthernet0/1');
  r1.getIgmpAgent().enableInterface('GigabitEthernet0/2');

  const received: Array<{ device: string; group: string; destinationPort: number }> = [];
  for (const [name, device] of [['RCV', rcv], ['OTHER', other]] as const) {
    device.attachCapture(({ direction, frame }) => {
      if (direction !== 'in') return;
      const ip = frame.payload as IPv4Packet | undefined;
      if (ip?.type !== 'ipv4' || ip.protocol !== IP_PROTO_UDP) return;
      const udp = ip.payload as UDPPacket;
      received.push({ device: name, group: ip.destinationIP.toString(), destinationPort: udp.destinationPort });
    }, 'FastEthernet0/1');
  }

  return { r1, src, rcv, other, received };
}

describe('IGMP membership feeds PimAgent OIL (rapport 02, item #43)', () => {
  it('a v2 membership report on a router interface adds that interface to the PIM (*,G) OIL', () => {
    const { r1, rcv } = topology();
    sendIgmpReport(rcv.getPort('FastEthernet0/1')!, '192.168.1.10', '239.5.5.5');
    const mroute = r1.getPimAgent().getMroute('239.5.5.5');
    expect(mroute?.outgoingInterfaces.has('GigabitEthernet0/1')).toBe(true);
  });
});

describe('Router forwards real multicast data to IGMP-joined receivers (rapport 02, item #43)', () => {
  it('a receiver that joined the group receives router-forwarded multicast UDP data; a non-member does not', () => {
    const { r1, src, rcv, received } = topology();
    sendIgmpReport(rcv.getPort('FastEthernet0/1')!, '192.168.1.10', '239.5.5.5');

    sendMulticastUdp(src.getPort('FastEthernet0/1')!, '10.0.0.50', '239.5.5.5');

    expect(received.some(r => r.device === 'RCV' && r.group === '239.5.5.5')).toBe(true);
    expect(received.some(r => r.device === 'OTHER')).toBe(false);
    expect(r1.getCounters().ipForwDatagrams).toBeGreaterThan(0);
  });

  it('224.0.1.0-239.255.255.255 is no longer incorrectly treated as always-local (the /24 boundary fix)', () => {
    // Under the old code, ANY destination with first octet 224-239 was
    // forced to local delivery — including this one. Only 224.0.0.0/24
    // is actually link-local per RFC 1112/4541.
    const { rcv, src, received } = topology();
    sendIgmpReport(rcv.getPort('FastEthernet0/1')!, '192.168.1.10', '224.0.1.1');
    sendMulticastUdp(src.getPort('FastEthernet0/1')!, '10.0.0.50', '224.0.1.1');
    expect(received.some(r => r.device === 'RCV' && r.group === '224.0.1.1')).toBe(true);
  });

  it('true link-local multicast (224.0.0.0/24) still never gets replicated, even with an OIL', () => {
    const { r1, src, received } = topology();
    // Force an OIL that would never occur for a link-local group in
    // practice — this exists purely to prove the /24 branch never even
    // reaches forwardMulticast, unlike 224.0.1.1 above.
    r1.getPimAgent().joinGroup('224.0.0.5', 'GigabitEthernet0/1');
    sendMulticastUdp(src.getPort('FastEthernet0/1')!, '10.0.0.50', '224.0.0.5');
    expect(received.some(r => r.group === '224.0.0.5')).toBe(false);
  });

  it('RPF failure drops a copy of the multicast data arriving on the wrong interface', () => {
    const { r1, src, rcv, other, received } = topology();
    sendIgmpReport(rcv.getPort('FastEthernet0/1')!, '192.168.1.10', '239.5.5.5');
    sendMulticastUdp(src.getPort('FastEthernet0/1')!, '10.0.0.50', '239.5.5.5', 4, 5000);
    expect(received.some(r => r.device === 'RCV' && r.destinationPort === 5000)).toBe(true);

    // Same (spoofed) source address, but arriving on GigabitEthernet0/2
    // instead of the RPF-correct GigabitEthernet0/0 — must be dropped.
    void r1;
    sendMulticastUdp(other.getPort('FastEthernet0/1')!, '10.0.0.50', '239.5.5.5', 4, 6000);
    expect(received.some(r => r.destinationPort === 6000)).toBe(false);
  });

  it('leaveGroup removes the interface from the OIL and forwarding stops', () => {
    const { rcv, src, received } = topology();
    sendIgmpReport(rcv.getPort('FastEthernet0/1')!, '192.168.1.10', '239.5.5.5');
    sendMulticastUdp(src.getPort('FastEthernet0/1')!, '10.0.0.50', '239.5.5.5', 4, 7000);
    expect(received.some(r => r.destinationPort === 7000)).toBe(true);

    rcv.getPort('FastEthernet0/1')!.sendFrame({
      srcMAC: rcv.getPort('FastEthernet0/1')!.getMAC(),
      dstMAC: new MACAddress(ipv4MulticastToMac('224.0.0.2')),
      etherType: ETHERTYPE_IPV4,
      payload: (() => {
        const payload: IgmpPacket = {
          type: 'igmp', version: 2, messageType: 'leave-group',
          maxRespTimeDs: 0, groupAddress: '239.5.5.5', checksum: 0,
        };
        const ipPkt: IPv4Packet = {
          type: 'ipv4', version: 4, ihl: 6, tos: 0xc0, totalLength: 32,
          identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
          ttl: 1, protocol: 2, headerChecksum: 0,
          sourceIP: new IPAddress('192.168.1.10'), destinationIP: new IPAddress('224.0.0.2'),
          payload,
        };
        ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
        return ipPkt;
      })(),
    });

    sendMulticastUdp(src.getPort('FastEthernet0/1')!, '10.0.0.50', '239.5.5.5', 4, 8000);
    expect(received.some(r => r.destinationPort === 8000)).toBe(false);
  });
});
