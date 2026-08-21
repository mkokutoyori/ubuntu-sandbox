import {
  ETHERTYPE_ARP, IPAddress, MACAddress,
  type ARPPacket, type EthernetFrame,
} from '@/network/core/types';

export interface AddressProbePort {
  getMAC(): MACAddress;
  getIPAddress(): IPAddress | null;
}

export interface AddressProbeSink {
  sendFrame(iface: string, frame: EthernetFrame): void;
  hasNeighbour(ip: string): boolean;
}

export function addressAnswersOnLink(
  sink: AddressProbeSink, iface: string, port: AddressProbePort, target: IPAddress,
): boolean {
  const key = target.toString();
  if (sink.hasNeighbour(key)) return true;

  const myIP = port.getIPAddress();
  if (!myIP) return false;

  const request: ARPPacket = {
    type: 'arp', operation: 'request',
    senderMAC: port.getMAC(), senderIP: myIP,
    targetMAC: MACAddress.broadcast(), targetIP: target,
  };
  sink.sendFrame(iface, {
    srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
    etherType: ETHERTYPE_ARP, payload: request,
  });
  return sink.hasNeighbour(key);
}
