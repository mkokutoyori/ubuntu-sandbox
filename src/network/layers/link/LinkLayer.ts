import type { EthernetFrame } from '../../core/types';
import { MACAddress } from '../../core/types';
import type { Port } from '../../hardware/Port';

export type LinkPacketType = 'host' | 'broadcast' | 'multicast' | 'otherhost';

const GROUP_BIT = 0x01;

export function isGroupAddress(mac: MACAddress): boolean {
  return (mac.getOctets()[0] & GROUP_BIT) === GROUP_BIT;
}

export function isBroadcastAddress(mac: MACAddress): boolean {
  return mac.isBroadcast();
}

export function classifyDestination(
  destination: MACAddress, own: MACAddress,
): LinkPacketType {
  if (isBroadcastAddress(destination)) return 'broadcast';
  if (isGroupAddress(destination)) return 'multicast';
  return destination.equals(own) ? 'host' : 'otherhost';
}

export interface LinkFrameDelivery {
  readonly iface: string;
  readonly frame: EthernetFrame;
  readonly packetType: LinkPacketType;
  readonly wasLinkBroadcast: boolean;
  readonly wasLinkMulticast: boolean;
}

export interface LinkSendRequest {
  readonly iface: string;
  readonly destination: MACAddress;
  readonly etherType: number;
  readonly payload: unknown;
  readonly source?: MACAddress;
  readonly vlanId?: number;
  readonly dot1q?: { tpid: number; pcp: number; dei: number; vid: number };
}

export interface LinkLayerPorts {
  getPort(name: string): Port | null | undefined;
  transmit?(iface: string, frame: EthernetFrame): boolean;
  ownsLocalUnicast?(iface: string, destination: MACAddress): boolean;
}

export class LinkLayer {
  constructor(private readonly ports: LinkLayerPorts) {}

  send(request: LinkSendRequest): boolean {
    const port = this.ports.getPort(request.iface);
    if (!port) return false;

    const frame: EthernetFrame = {
      srcMAC: request.source ?? port.getMAC(),
      dstMAC: request.destination,
      etherType: request.etherType,
      payload: request.payload,
      ...(request.vlanId !== undefined ? { vlanId: request.vlanId } : {}),
      ...(request.dot1q !== undefined ? { dot1q: request.dot1q } : {}),
    };
    return this.ports.transmit
      ? this.ports.transmit(request.iface, frame)
      : port.sendFrame(frame);
  }

  deliver(iface: string, frame: EthernetFrame): LinkFrameDelivery | null {
    const port = this.ports.getPort(iface);
    if (!port) return null;

    let packetType = classifyDestination(frame.dstMAC, port.getMAC());
    if (packetType === 'otherhost'
      && this.ports.ownsLocalUnicast?.(iface, frame.dstMAC) === true) {
      packetType = 'host';
    }
    if (packetType === 'otherhost' && !port.isPromiscuous()) return null;

    return {
      iface,
      frame,
      packetType,
      wasLinkBroadcast: packetType === 'broadcast',
      wasLinkMulticast: packetType === 'multicast',
    };
  }
}
