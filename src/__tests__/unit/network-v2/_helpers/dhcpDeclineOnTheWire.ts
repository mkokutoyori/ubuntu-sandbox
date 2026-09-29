import { DHCPPacket, DHCP_WIRE_BYTES } from '@/network/dhcp/DHCPPacket';
import { ETHERTYPE_IPV4, IPAddress, MACAddress } from '@/network/core/types';
import { buildUdpOverIpv4 } from '@/network/layers/transport/UdpEgress';
import { DHCP_CLIENT_PORT, DHCP_SERVER_PORT } from '@/network/core/WellKnownPorts';
import type { Port } from '@/network/hardware/Port';

export function declineOnTheWire(port: Port, declinedAddress: string, serverAddress: string): boolean {
  const decline = DHCPPacket.createDecline(port.getMAC().toString(), 0x5eed, declinedAddress, serverAddress);
  return port.sendFrame({
    srcMAC: port.getMAC(),
    dstMAC: MACAddress.broadcast(),
    etherType: ETHERTYPE_IPV4,
    payload: buildUdpOverIpv4(new IPAddress('0.0.0.0'), {
      destination: new IPAddress('255.255.255.255'),
      sourcePort: DHCP_CLIENT_PORT, destinationPort: DHCP_SERVER_PORT,
      payload: decline, payloadBytes: DHCP_WIRE_BYTES,
    }),
  });
}
