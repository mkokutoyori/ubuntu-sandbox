import {
  ETHERTYPE_ARP, ETHERTYPE_IPV4, IP_PROTO_UDP,
  type ARPPacket, type EthernetFrame, type IPAddress, type IPv4Packet, type MACAddress, type UDPPacket,
} from '../../../core/types';
import { DHCP_SERVER_PORT } from '../../../core/WellKnownPorts';
import { DHCP_OPTION, DHCPPacket } from '../../../dhcp/DHCPPacket';

export interface DetectedDevice {
  readonly mac: MACAddress;
  readonly vdom: string;
  readonly iface: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly address: IPAddress | null;
  readonly hostName: string | null;
}

export interface DeviceObservation {
  readonly address?: IPAddress;
  readonly hostName?: string;
}

export interface DeviceInventoryDeps {
  now(): number;
  vdomOf(iface: string): string;
  onDetected(device: DetectedDevice): void;
}

interface HeldDevice {
  readonly mac: MACAddress;
  readonly vdom: string;
  readonly createdAt: number;
  iface: string;
  lastSeenAt: number;
  address: IPAddress | null;
  hostName: string | null;
}

export class DeviceInventory {
  private readonly identifying = new Set<string>();
  private readonly devices = new Map<string, HeldDevice>();

  constructor(private readonly deps: DeviceInventoryDeps) {}

  setIdentification(iface: string, enabled: boolean): void {
    if (enabled) this.identifying.add(iface);
    else this.identifying.delete(iface);
  }

  identifies(iface: string): boolean {
    return this.identifying.has(iface);
  }

  observe(iface: string, mac: MACAddress, observation: DeviceObservation = {}): void {
    if (!this.identifying.has(iface) || mac.isGroup()) return;
    const vdom = this.deps.vdomOf(iface);
    const key = `${vdom}|${mac}`;
    const now = this.deps.now();
    const held = this.devices.get(key);
    if (held) {
      held.iface = iface;
      held.lastSeenAt = now;
      if (observation.address) held.address = observation.address;
      if (observation.hostName) held.hostName = observation.hostName;
      return;
    }
    const device: HeldDevice = {
      mac, vdom, iface, createdAt: now, lastSeenAt: now,
      address: observation.address ?? null, hostName: observation.hostName ?? null,
    };
    this.devices.set(key, device);
    this.deps.onDetected({ ...device });
  }

  list(): readonly DetectedDevice[] {
    return [...this.devices.values()].map((device) => ({ ...device }));
  }
}

export function observationOf(frame: EthernetFrame): DeviceObservation {
  if (frame.etherType === ETHERTYPE_ARP) {
    const sender = (frame.payload as ARPPacket).senderIP;
    return sender.isUnspecified() ? {} : { address: sender };
  }
  if (frame.etherType !== ETHERTYPE_IPV4) return {};
  const packet = frame.payload as IPv4Packet;
  if (packet.protocol !== IP_PROTO_UDP) return {};
  const datagram = packet.payload as UDPPacket;
  if (datagram.destinationPort !== DHCP_SERVER_PORT || !(datagram.payload instanceof DHCPPacket)) return {};
  const hostName = datagram.payload.getOption(DHCP_OPTION.HOST_NAME);
  return typeof hostName === 'string' && hostName.length > 0 ? { hostName } : {};
}
