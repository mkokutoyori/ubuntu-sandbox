import {
  ETHERTYPE_IPV4, IPAddress, MACAddress,
  type EthernetFrame, type IPv4Packet,
} from '../core/types';
import { DHCP_CLIENT_PORT, DHCP_SERVER_PORT } from '../core/WellKnownPorts';
import { buildUdpOverIpv4 } from '../layers/transport/UdpEgress';
import { DHCP_WIRE_BYTES, type DHCPPacket } from './DHCPPacket';
import type { DhcpUnicastTarget } from './types';

export interface DhcpClientAddressing {
  readonly source: IPAddress;
  readonly destination: IPAddress;
  readonly destinationMac: MACAddress | null;
}

export function dhcpClientAddressing(pkt: DHCPPacket, target?: DhcpUnicastTarget): DhcpClientAddressing {
  return {
    source: new IPAddress(pkt.ciaddr),
    destination: new IPAddress(target?.ip ?? '255.255.255.255'),
    destinationMac: target?.mac ? new MACAddress(target.mac) : null,
  };
}

export function dhcpClientPacket(pkt: DHCPPacket, target?: DhcpUnicastTarget): IPv4Packet {
  const addressing = dhcpClientAddressing(pkt, target);
  return buildUdpOverIpv4(addressing.source, {
    destination: addressing.destination,
    sourcePort: DHCP_CLIENT_PORT, destinationPort: DHCP_SERVER_PORT,
    payload: pkt, payloadBytes: DHCP_WIRE_BYTES,
  });
}

export function dhcpClientFrame(
  pkt: DHCPPacket, sourceMac: MACAddress, target?: DhcpUnicastTarget,
): EthernetFrame {
  return {
    srcMAC: sourceMac,
    dstMAC: dhcpClientAddressing(pkt, target).destinationMac ?? MACAddress.broadcast(),
    etherType: ETHERTYPE_IPV4,
    payload: dhcpClientPacket(pkt, target),
  };
}
