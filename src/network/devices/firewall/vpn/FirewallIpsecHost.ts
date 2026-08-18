import { IP_PROTO_UDP, UDP_PORT_IKE, UDP_PORT_IKE_NAT_T } from '../../../core/types';
import type { IPv4Packet, UDPPacket } from '../../../core/types';
import type { InterfaceTable } from '../l3/InterfaceTable';
import type { RouteTable } from '../l3/RouteTable';

export interface IpsecHostFactDeps {
  readonly interfaces: InterfaceTable;
  readonly routes: () => RouteTable;
  readonly connected: (iface: string) => boolean | undefined;
}

export interface IpsecHostFacts {
  readonly localIp: (iface: string) => string | null;
  readonly localIps: () => string[];
  readonly interfaceDown: (iface: string) => boolean;
  readonly egressFor: (peerIp: string) => string | undefined;
}

export function ipsecHostFacts(deps: IpsecHostFactDeps): IpsecHostFacts {
  return {
    localIp: (iface) => (iface
      ? deps.interfaces.get(iface)?.ip ?? null
      : deps.interfaces.all().find(entry => entry.ip !== undefined)?.ip ?? null),
    localIps: () => deps.interfaces.all()
      .map(entry => entry.ip).filter((ip): ip is string => ip !== undefined),
    interfaceDown: (iface) => deps.connected(iface) === false,
    egressFor: (peerIp) => deps.routes().resolveNextHop(peerIp)?.iface
      ?? deps.interfaces.interfaceForDestination(peerIp),
  };
}

export function ikeDatagram(packet: IPv4Packet): UDPPacket | null {
  if (packet.protocol !== IP_PROTO_UDP) return null;

  const udp = packet.payload as UDPPacket | undefined;
  if (udp?.type !== 'udp') return null;
  if (udp.destinationPort !== UDP_PORT_IKE
    && udp.destinationPort !== UDP_PORT_IKE_NAT_T) return null;

  return udp;
}
