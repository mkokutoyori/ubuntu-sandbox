import type { EthernetFrame, IPAddress, IPv4Packet } from '../../core/types';
import type { UdpSendRequest } from '../../layers/transport/UdpEgress';
import { UDP_PORT_IKE } from '../../core/types';
import type { Port } from '../../hardware/Port';
import type { IEventBus } from '../../../events/EventBus';
import { TcpStack } from '../../tcp/TcpStack';
import { IPSecEngine } from '../../ipsec/IPSecEngine';
import { RadiusClientAgent } from '../../radius/RadiusClientAgent';
import { TacacsClientAgent } from '../../tacacs/TacacsClientAgent';
import type { RouterHostsTable } from '../router/dns/RouterHostsTable';

export interface FirewallAgentDeps {
  readonly id: string;
  readonly name: string;
  readonly hostname: () => string;
  readonly hostsTable: () => RouterHostsTable;
  readonly bus: () => IEventBus;
  readonly port: (name: string) => Port | undefined;
  readonly ports: () => Port[];
  readonly send: (port: string, frame: EthernetFrame) => void;
  readonly resolveMac: (ip: string) => ReturnType<Port['getMAC']> | null;
  readonly sendArpAware: (
    port: string, packet: IPv4Packet, nextHop: IPAddress) => void;
  readonly sendUdpDatagram: (request: UdpSendRequest) => boolean;
  readonly sourceAddressFor: (destination: IPAddress) => IPAddress | null;
  readonly sendUdp: (destIp: string, port: number, payload: unknown) => boolean;
  readonly localIp: (iface: string) => string | null;
  readonly localIps: () => string[];
  readonly interfaceDown: (iface: string) => boolean;
  readonly egressFor: (peerIp: string) => string | undefined;
}

export interface FirewallAgents {
  readonly tcp: TcpStack;
  readonly ipsec: IPSecEngine;
  readonly radius: RadiusClientAgent;
  readonly tacacs: TacacsClientAgent;
}

const NAT_T_PORT = 4500;

export function buildFirewallAgents(deps: FirewallAgentDeps): FirewallAgents {
  const host = {
    id: deps.id,
    name: deps.name,
    getHostname: deps.hostname,
    getName: () => deps.name,
    _getHostnameInternal: deps.hostname,
    _getHostsTable: deps.hostsTable,
    _sendIkeUdp: (destIp: string, payload: unknown) =>
      deps.sendUdp(destIp, UDP_PORT_IKE, payload),
    _sendNatTKeepalive: (destIp: string) =>
      deps.sendUdp(destIp, NAT_T_PORT,
        { type: 'nat-t-keepalive', bytes: new Uint8Array([0xff]) }),
    _ipsecLocalIp: deps.localIp,
    _ipsecLocalIps: deps.localIps,
    _ipsecInterfaceDown: deps.interfaceDown,
    _ipsecEgressInterfaceFor: deps.egressFor,
    getPort: deps.port,
    getPorts: deps.ports,
    sendFrame: deps.send,
    resolveMac: deps.resolveMac,
    sendIpv4FrameArpAware: deps.sendArpAware,
    sendUdpDatagram: deps.sendUdpDatagram,
    sourceAddressFor: deps.sourceAddressFor,
  };

  const tcp = new TcpStack(host, deps.bus);
  tcp.start();

  const ipsec = new IPSecEngine(host);
  ipsec.setEventBus(deps.bus());
  ipsec.start();

  const radius = new RadiusClientAgent(host, deps.bus);
  radius.start();

  const tacacs = new TacacsClientAgent(host, deps.bus, () => tcp);
  tacacs.start();

  return { tcp, ipsec, radius, tacacs };
}
