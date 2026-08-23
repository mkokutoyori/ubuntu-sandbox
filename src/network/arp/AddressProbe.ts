import {
  ETHERTYPE_ARP, ETHERTYPE_IPV4, IPAddress, MACAddress,
  type ARPPacket, type EthernetFrame,
} from '@/network/core/types';
import { buildEchoRequest } from '@/network/icmp/IcmpEcho';

export interface AddressProbePort {
  getMAC(): MACAddress;
  getIPAddress(): IPAddress | null;
}

export interface AddressProbeSink {
  sendFrame(iface: string, frame: EthernetFrame): void;
  hasNeighbour(ip: string): boolean;
  neighbourMac(ip: string): MACAddress | undefined;
  answersEcho(from: string, send: () => void): boolean;
}

let nextIdentifier = 1;

export function addressAnswersOnLink(
  sink: AddressProbeSink, iface: string, port: AddressProbePort, target: IPAddress,
): boolean {
  const key = target.toString();
  const myIP = port.getIPAddress();
  if (!myIP) return false;

  if (!sink.hasNeighbour(key)) {
    const request: ARPPacket = {
      type: 'arp', operation: 'request',
      senderMAC: port.getMAC(), senderIP: myIP,
      targetMAC: MACAddress.broadcast(), targetIP: target,
    };
    sink.sendFrame(iface, {
      srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_ARP, payload: request,
    });
  }

  const mac = sink.neighbourMac(key);
  if (!mac) return false;

  const identifier = nextIdentifier++ & 0xffff;
  const packet = buildEchoRequest(myIP.toString(), key, identifier, 0);
  return sink.answersEcho(key, () => {
    sink.sendFrame(iface, {
      srcMAC: port.getMAC(), dstMAC: mac,
      etherType: ETHERTYPE_IPV4, payload: packet,
    });
  });
}
