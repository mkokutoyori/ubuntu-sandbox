import {
  IP_PROTO_OSPF,
  type EthernetFrame, type IPv4Packet, type MACAddress, type IPAddress,
} from '../../../core/types';
import type { IEventBus } from '../../../../events/EventBus';
import type { ConnectedRoute, InterfaceTable } from '../l3/InterfaceTable';
import type { Port } from '../../../hardware/Port';
import type { RouteTable } from '../l3/RouteTable';
import type { TcpStack } from '../../../tcp/TcpStack';
import { FirewallRouting, ripPacketOf, type RoutingPortFacts } from './FirewallRouting';

export type { FirewallRouting };

export interface RoutingWiringHost {
  readonly deviceId: string;
  hostname(): string;
  bus(): IEventBus;
  routes(): RouteTable;
  connectedRoutes(): readonly ConnectedRoute[];
  interfaceAddresses(): readonly RoutingPortFacts[];
  resolvedMac(ip: string): MACAddress | undefined;
  emitFrame(iface: string, frame: EthernetFrame): void;
  emitArpAware(iface: string, packet: IPv4Packet, nextHop: IPAddress): void;
  tcp(): TcpStack;
}

export function createFirewallRouting(host: RoutingWiringHost): FirewallRouting {
  return new FirewallRouting({
    deviceId: host.deviceId,
    hostname: () => host.hostname(),
    bus: () => host.bus(),
    ports: () => host.interfaceAddresses(),
    sendFrame: (iface, frame) => { host.emitFrame(iface, frame); },
    sendArpAware: (iface, packet, nextHop) => { host.emitArpAware(iface, packet, nextHop); },
    connectedRoutes: () => host.connectedRoutes(),
    installRoute: (route) => {
      host.routes().addStatic(route.network, route.mask, route.nextHop, {
        iface: route.iface || undefined,
        distance: route.distance,
        metric: route.metric,
        id: `${route.source}:${route.network}/${route.mask}`,
        routeType: route.routeType,
      });
    },
    removeRoutes: (source) => { host.routes().removeStaticsBySource(source); },
    resolvedMac: (ip) => host.resolvedMac(ip),
    tcp: () => host.tcp(),
  });
}

export function deliverToRoutingProtocol(
  routing: FirewallRouting, portName: string, packet: IPv4Packet,
): boolean {
  if (packet.protocol === IP_PROTO_OSPF) {
    routing.receiveOspf(portName, packet.sourceIP.toString(), packet.payload as never);
    return true;
  }

  const rip = ripPacketOf(packet);
  if (!rip) return false;

  routing.receiveRip(portName, packet.sourceIP, rip);
  return true;
}

export function routingPortFacts(
  interfaces: InterfaceTable, portOf: (name: string) => Port | undefined,
): readonly RoutingPortFacts[] {
  const facts: RoutingPortFacts[] = [];
  for (const iface of interfaces.all()) {
    const port = portOf(iface.name);
    if (!port || !iface.ip || !iface.mask) continue;
    facts.push({ name: iface.name, ip: iface.ip, mask: iface.mask, mac: port.getMAC() });
  }
  return Object.freeze(facts);
}
