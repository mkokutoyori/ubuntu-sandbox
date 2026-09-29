import type { EthernetFrame, MACAddress } from '../../../core/types';
import type { IEventBus } from '../../../../events/EventBus';
import type { TcpSocket, TcpStack } from '../../../tcp/TcpStack';
import { BGP_PORT } from '../../../bgp/messages';
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
import { IPAddress, type IPv4Packet } from '../../../core/types';

export interface L3ServiceHost {
  readonly deviceId: string;
  hostname(): string;
  bus(): IEventBus;
  tcp(): TcpStack;
  vdomRoutes(vdom: string): RouteTable;
  vdomOfInterface(iface: string): string;
  routesOf(iface: string | undefined): RouteTable;
  interfaces(): InterfaceTable;
  port(iface: string): Port | undefined;
  resolvedMac(ip: string): MACAddress | undefined;
  emitFrame(iface: string, frame: EthernetFrame): void;
  emitArpAware(iface: string, packet: IPv4Packet, nextHop: IPAddress): void;
  probeAddress(iface: string, address: string): boolean;
  assignAddress(iface: string, ip: string, mask: string): void;
  forward(iface: string, packet: IPv4Packet, gateway?: string): void;
  systemDnsServers?(): readonly string[];
  now(): number;
}

export interface L3Services {
  routingOf(vdom: string): FirewallRouting;
  routings(): readonly FirewallRouting[];
  routingForInterface(iface: string): FirewallRouting;
  readonly dhcp: FirewallDhcp;
  readonly sdwan: SdwanService;
}

export function buildL3Services(host: L3ServiceHost): L3Services {
  const bgpAcceptors = new Map<string, (socket: TcpSocket) => void>();
  let bgpListening = false;
  const listenBgp = (vdom: string, accept: (socket: TcpSocket) => void): void => {
    bgpAcceptors.set(vdom, accept);
    if (bgpListening) return;
    bgpListening = true;
    host.tcp().listen(BGP_PORT, {
      onAccept: (socket) => {
        const owner = host.interfaces().owningInterface(socket.localIp);
        const accept = owner === undefined ? undefined : bgpAcceptors.get(host.vdomOfInterface(owner));
        if (accept) accept(socket); else socket.close();
      },
    });
  };

  const instances = new Map<string, FirewallRouting>();
  const routingOf = (vdom: string): FirewallRouting => {
    const known = instances.get(vdom);
    if (known) return known;
    const inVdom = (iface: string) => host.vdomOfInterface(iface) === vdom;
    const created = createFirewallRouting({
      deviceId: host.deviceId,
      hostname: () => host.hostname(),
      bus: () => host.bus(),
      routes: () => host.vdomRoutes(vdom),
      connectedRoutes: () => host.interfaces().connectedRoutes().filter((route) => inVdom(route.iface)),
      interfaceAddresses: () => routingPortFacts(host.interfaces(), (n) => host.port(n))
        .filter((port) => inVdom(port.name)),
      resolvedMac: (ip) => host.resolvedMac(ip),
      tcp: () => host.tcp(),
      listenBgp: (accept) => { listenBgp(vdom, accept); },
      emitFrame: (iface, frame) => { host.emitFrame(iface, frame); },
      emitArpAware: (iface, packet, nextHop) => { host.emitArpAware(iface, packet, nextHop); },
    });
    instances.set(vdom, created);
    return created;
  };

  const dhcp = createFirewallDhcp({
    deviceId: host.deviceId,
    now: () => host.now(),
    hostname: () => host.hostname(),
    bus: () => host.bus(),
    interfaceAddress: (iface) => {
      const entry = host.interfaces().get(iface);
      return entry?.ip && entry.mask ? { ip: entry.ip, mask: entry.mask } : undefined;
    },
    portMac: (iface) => host.port(iface)?.getMAC(),
    emitFrame: (iface, frame) => { host.emitFrame(iface, frame); },
    addressInUse: (iface, address) => host.probeAddress(iface, address),
    leaseGranted: (iface, ip, mask, gateway) => {
      host.assignAddress(iface, ip, mask);
      if (gateway) host.routesOf(iface).addDefault(gateway, { id: `dhcp:${iface}` });
    },
    leaseLost: (iface) => { host.routesOf(iface).removeStaticById(`dhcp:${iface}`); },
    systemDnsServers: () => host.systemDnsServers?.() ?? [],
    sendToServer: (server, packet) => {
      const relaying = host.interfaces().owningInterface(packet.sourceIP.toString());
      const hop = host.routesOf(relaying).resolveNextHop(server.toString());
      if (!hop) return false;
      host.emitArpAware(hop.iface, packet, new IPAddress(hop.nextHop));
      return true;
    },
    interfaceOwning: (address) => host.interfaces().owningInterface(address) ?? null,
  });

  const sdwan = new SdwanService({
    send: (iface, packet, gateway) => { host.forward(iface, packet, gateway); },
    localIp: (iface) => host.interfaces().get(iface)?.ip,
    settle: () => Promise.resolve(),
  });

  return Object.freeze({
    routingOf,
    routings: () => [...instances.values()],
    routingForInterface: (iface: string) => routingOf(host.vdomOfInterface(iface)),
    dhcp,
    sdwan,
  });
}

export function claimedByControlPlane(
  services: L3Services, iface: string, packet: IPv4Packet, sourceMac: string,
): boolean {
  if (deliverToRoutingProtocol(services.routingForInterface(iface), iface, packet)) return true;

  const request = dhcpDatagram(packet);
  if (request) return services.dhcp.handleUdp(iface, packet, request);

  const reply = dhcpReplyDatagram(packet);
  if (reply) return services.dhcp.deliverToClient(iface, reply, sourceMac);

  return false;
}
