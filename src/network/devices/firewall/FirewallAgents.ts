import type { EthernetFrame, IPAddress, IPv4Packet } from '../../core/types';
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
  readonly sendUdp: (destIp: string, port: number, payload: unknown) => boolean;
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
    getPort: deps.port,
    getPorts: deps.ports,
    sendFrame: deps.send,
    resolveMac: deps.resolveMac,
    sendIpv4FrameArpAware: deps.sendArpAware,
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
