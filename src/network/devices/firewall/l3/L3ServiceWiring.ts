import type { EthernetFrame, MACAddress } from '../../../core/types';
import type { IEventBus } from '../../../../events/EventBus';
import type { TcpStack } from '../../../tcp/TcpStack';
import type { InterfaceTable } from './InterfaceTable';
import type { RouteTable } from './RouteTable';
import type { Port } from '../../../hardware/Port';
import {
  createFirewallRouting, routingPortFacts, type FirewallRouting,
} from '../routing/RoutingWiring';
import {
  createFirewallDhcp, dhcpDatagram, dhcpReplyDatagram, type FirewallDhcp,
} from './FirewallDhcp';
import { deliverToRoutingProtocol } from '../routing/RoutingWiring';
import { SdwanService } from '../sdwan/SdwanService';
import type { IPv4Packet, IPAddress } from '../../../core/types';

export interface L3ServiceHost {
  readonly deviceId: string;
  hostname(): string;
  bus(): IEventBus;
  tcp(): TcpStack;
  routes(): RouteTable;
  interfaces(): InterfaceTable;
  port(iface: string): Port | undefined;
  resolvedMac(ip: string): MACAddress | undefined;
  emitFrame(iface: string, frame: EthernetFrame): void;
  emitArpAware(iface: string, packet: IPv4Packet, nextHop: IPAddress): void;
  assignAddress(iface: string, ip: string, mask: string): void;
  forward(iface: string, packet: IPv4Packet, gateway?: string): void;
  systemDnsServers?(): readonly string[];
}

export interface L3Services {
  readonly routing: FirewallRouting;
  readonly dhcp: FirewallDhcp;
  readonly sdwan: SdwanService;
}

export function buildL3Services(host: L3ServiceHost): L3Services {
  const routing = createFirewallRouting({
    deviceId: host.deviceId,
    hostname: () => host.hostname(),
    bus: () => host.bus(),
    routes: () => host.routes(),
    connectedRoutes: () => host.interfaces().connectedRoutes(),
    interfaceAddresses: () => routingPortFacts(host.interfaces(), (n) => host.port(n)),
    resolvedMac: (ip) => host.resolvedMac(ip),
    tcp: () => host.tcp(),
    emitFrame: (iface, frame) => { host.emitFrame(iface, frame); },
    emitArpAware: (iface, packet, nextHop) => { host.emitArpAware(iface, packet, nextHop); },
  });

  const dhcp = createFirewallDhcp({
    deviceId: host.deviceId,
    hostname: () => host.hostname(),
    bus: () => host.bus(),
    interfaceAddress: (iface) => {
      const entry = host.interfaces().get(iface);
      return entry?.ip && entry.mask ? { ip: entry.ip, mask: entry.mask } : undefined;
    },
    portMac: (iface) => host.port(iface)?.getMAC(),
    emitFrame: (iface, frame) => { host.emitFrame(iface, frame); },
    leaseGranted: (iface, ip, mask, gateway) => {
      host.assignAddress(iface, ip, mask);
      if (gateway) host.routes().addDefault(gateway, { id: `dhcp:${iface}` });
    },
    leaseLost: (iface) => { host.routes().removeStaticById(`dhcp:${iface}`); },
    systemDnsServers: () => host.systemDnsServers?.() ?? [],
  });

  const sdwan = new SdwanService({
    send: (iface, packet, gateway) => { host.forward(iface, packet, gateway); },
    localIp: (iface) => host.interfaces().get(iface)?.ip,
    settle: () => Promise.resolve(),
  });

  return Object.freeze({ routing, dhcp, sdwan });
}

export function claimedByControlPlane(
  services: L3Services, iface: string, packet: IPv4Packet, sourceMac: string,
): boolean {
  if (deliverToRoutingProtocol(services.routing, iface, packet)) return true;

  const request = dhcpDatagram(packet);
  if (request) return services.dhcp.handleUdp(iface, packet, request);

  const reply = dhcpReplyDatagram(packet);
  if (reply) return services.dhcp.deliverToClient(iface, reply, sourceMac);

  return false;
}
