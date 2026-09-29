import {
  IPAddress, MACAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
} from '../../../core/types';
import { buildUdpOverIpv4 } from '../../../layers/transport/UdpEgress';
import { inSameSubnet, ipToUint32, tryIpToUint32, uint32ToIp } from '../../../core/ip';
import { DHCPServer } from '../../../dhcp/DHCPServer';
import { DHCPClient } from '../../../dhcp/DHCPClient';
import { WireDhcpChannel } from '../../../dhcp/DhcpServerChannel';
import { dhcpClientFrame } from '../../../dhcp/DhcpClientFrame';
import { dhcpLinkDestination, dhcpServerReplyFrame } from '../../../dhcp/DhcpServerReplyFrame';
import type { DhcpUnicastTarget } from '../../../dhcp/types';
import { DHCPPacket, DHCP_WIRE_BYTES } from '../../../dhcp/DHCPPacket';
import { buildDhcpServerReply, dhcpReplyRoute, type DhcpReplyRoute } from '../../../dhcp/DhcpServerExchange';
import type { IEventBus } from '../../../../events/EventBus';
import { DHCP_SERVER_PORT, DHCP_CLIENT_PORT } from '@/network/core/WellKnownPorts';
import { relayDhcpReply, relayDhcpRequest, type DhcpRelayHost } from '../../../dhcp/DhcpRelay';



export interface DhcpScope {
  readonly id: string;
  readonly enabled: boolean;
  readonly iface: string;
  readonly defaultGateway: string;
  readonly netmask: string;
  readonly dnsServers: readonly string[];
  readonly domain: string;
  readonly leaseTimeSec: number;
  readonly conflictedIpTimeoutSec?: number;
  readonly ranges: ReadonlyArray<{ startIp: string; endIp: string }>;
  readonly dnsService?: string;
  readonly reservations?: ReadonlyArray<{
    id: string; ip: string; mac: string; description: string;
  }>;
}

export interface FirewallDhcpDeps {
  readonly deviceId: string;
  readonly now: () => number;
  readonly hostname: () => string;
  readonly bus: () => IEventBus;
  readonly interfaceAddress: (iface: string) => { ip: string; mask: string } | undefined;
  readonly portMac: (iface: string) => MACAddress | undefined;
  readonly sendFrame: (iface: string, frame: EthernetFrame) => void;
  readonly configureInterface: (iface: string, ip: string, mask: string) => void;
  readonly installLeaseRoute: (iface: string, gateway: string | null, distance: number) => void;
  readonly clearInterface: (iface: string) => void;
  readonly systemDnsServers?: () => readonly string[];
  readonly sendToServer?: (server: IPAddress, packet: IPv4Packet) => boolean;
  readonly interfaceOwning?: (address: string) => string | null;
  readonly addressInUse?: (iface: string, address: string) => boolean;
}

export interface DhcpClientRoute {
  readonly gateway: boolean;
  readonly distance: number;
}

const DEFAULT_CLIENT_ROUTE: DhcpClientRoute = { gateway: true, distance: 5 };
const POOL_USAGE_TRAP_PERCENT = 90;
const UNLIMITED_LEASE = 0;

function poolNameOf(scope: DhcpScope): string {
  return `scope-${scope.id}`;
}

export function dhcpServerId(scope: DhcpScope): number | null {
  const id = Number.parseInt(scope.id, 10);
  return Number.isInteger(id) ? id : null;
}

export class FirewallDhcp {
  private readonly relays = new Map<string, readonly string[]>();

  private readonly server = new DHCPServer();
  private readonly scopes = new Map<string, DhcpScope>();
  private readonly client: DHCPClient;
  private readonly channels = new Map<string, WireDhcpChannel>();

  constructor(private readonly deps: FirewallDhcpDeps) {
    this.server.setDeviceId(deps.deviceId, deps.hostname());
    this.server.setEventBus(deps.bus());
    this.server.setClock(deps.now);
    this.client = new DHCPClient(
      (iface) => deps.portMac(iface)?.toString() ?? '00:00:00:00:00:00',
      (iface, ip, mask, gateway) => {
        deps.configureInterface(iface, ip, mask);
        this.installGateway(iface, gateway);
      },
      (iface) => { deps.clearInterface(iface); });
    this.client.setDeviceId(deps.deviceId, deps.hostname());
    this.client.setEventBus(deps.bus());
    this.client.setClock(deps.now);
    this.client.setWireChannelFactory((iface) => this.channelFor(iface));
  }

  private readonly clientInterfaces = new Map<string, DhcpClientRoute>();

  acquireLease(iface: string): string {
    return this.client.requestLease(iface, {});
  }

  startClient(iface: string): void {
    if (this.client.getState(iface).lease === null) this.client.requestLease(iface, {});
  }

  setClientMode(iface: string, route: DhcpClientRoute | null): void {
    if (route === null) {
      if (!this.clientInterfaces.delete(iface)) return;
      this.client.abandonLease(iface);
      return;
    }
    this.clientInterfaces.set(iface, route);
    const lease = this.client.getState(iface).lease;
    if (lease !== null) this.installGateway(iface, lease.defaultGateway);
  }

  private installGateway(iface: string, gateway: string | null): void {
    const route = this.clientInterfaces.get(iface) ?? DEFAULT_CLIENT_ROUTE;
    this.deps.installLeaseRoute(iface, route.gateway ? gateway : null, route.distance);
  }

  isClientInterface(iface: string): boolean {
    return this.clientInterfaces.has(iface);
  }

  releaseLease(iface: string): void {
    this.channels.delete(iface);
  }

  private channelFor(iface: string): WireDhcpChannel {
    const existing = this.channels.get(iface);
    if (existing) return existing;

    const channel = new WireDhcpChannel(iface, (name, pkt, target) => {
      this.emitClientFrame(name, pkt, target);
    }, this.deps.now);
    this.channels.set(iface, channel);
    return channel;
  }

  private emitClientFrame(iface: string, pkt: DHCPPacket, target?: DhcpUnicastTarget): void {
    const mac = this.deps.portMac(iface);
    if (!mac) return;

    this.deps.sendFrame(iface, dhcpClientFrame(pkt, mac, target));
  }

  deliverToClient(iface: string, udp: UDPPacket, sourceMac: string): boolean {
    if (udp.destinationPort !== DHCP_CLIENT_PORT) return false;

    const reply = udp.payload as DHCPPacket | undefined;
    if (!reply || reply.op !== 2) return true;

    this.channels.get(iface)?.deliver(reply, sourceMac);
    return true;
  }

  leases(): ReadonlyArray<{
    iface: string; ip: string; mac: string; hostName: string; expiresAt: number;
  }> {
    const found: Array<{
      iface: string; ip: string; mac: string; hostName: string; expiresAt: number;
    }> = [];
    for (const [ip, binding] of this.server.getBindings()) {
      const scope = this.scopeOfPool(binding.poolName);
      found.push({
        iface: scope?.iface ?? '',
        ip,
        mac: new MACAddress(binding.clientId).toString(),
        hostName: binding.hostName ?? '',
        expiresAt: binding.leaseExpiration,
      });
    }
    return found;
  }

  upsertScope(scope: DhcpScope): string | null {
    const problem = this.reservationProblem(scope);
    if (problem !== null) return problem;
    this.scopes.set(scope.id, scope);
    this.rebuild();
    return null;
  }

  private reservationProblem(scope: DhcpScope): string | null {
    const subnet = this.poolSubnet(scope);
    const byIp = new Map<string, string>();
    const byMac = new Map<string, string>();
    for (const reservation of scope.reservations ?? []) {
      if (reservation.mac.length === 0 || reservation.ip === '0.0.0.0') continue;
      const mac = new MACAddress(reservation.mac).toString();
      if (subnet !== null && networkOf(reservation.ip, subnet.mask) !== subnet.network) {
        return `the IP address ${reservation.ip} is outside the subnet ${subnet.network}/${subnet.mask} of the DHCP server.`;
      }
      const sameIp = byIp.get(reservation.ip);
      if (sameIp !== undefined) {
        return `the IP address ${reservation.ip} is already reserved by entry ${sameIp}.`;
      }
      const sameMac = byMac.get(mac);
      if (sameMac !== undefined) {
        return `the MAC address ${mac} is already reserved by entry ${sameMac}.`;
      }
      byIp.set(reservation.ip, reservation.id);
      byMac.set(mac, reservation.id);
    }
    return null;
  }

  removeScope(id: string): void {
    this.scopes.delete(id);
    this.rebuild();
  }

  private rebuild(): void {
    this.server.setEventBus(this.deps.bus());
    for (const name of [...this.server.getAllPools().keys()]) this.server.deletePool(name);
    for (const range of this.server.getExcludedRanges()) {
      this.server.removeExcludedRange(range.start, range.end);
    }

    const serving = [...this.scopes.values()]
      .filter(scope => scope.enabled && scope.ranges.length > 0);
    for (const scope of serving) this.declarePool(scope);

    if (serving.length === 0) { this.server.disable(); return; }
    this.server.enable();
    if (!this.server.isRunning()) this.server.start();
  }

  private resolvedDnsServers(scope: DhcpScope, localIp?: string): string[] {
    if (scope.dnsService === 'local') return localIp ? [localIp] : [];
    if (scope.dnsService === 'default') {
      return [...(this.deps.systemDnsServers?.() ?? [])];
    }
    return [...scope.dnsServers];
  }

  clearLease(ip: string): boolean {
    return this.server.clearBinding(ip);
  }

  clearAllLeases(): void {
    this.server.clearBindings();
  }

  getServer(): DHCPServer { return this.server; }

  scopeOfInterface(iface: string): DhcpScope | undefined {
    for (const scope of this.scopes.values()) {
      if (scope.enabled && scope.iface === iface && scope.ranges.length > 0) return scope;
    }
    return undefined;
  }

  setRelay(iface: string, servers: readonly string[] | null): void {
    if (servers && servers.length > 0) this.relays.set(iface, [...servers]);
    else this.relays.delete(iface);
  }

  relayServers(iface: string): readonly string[] {
    return this.relays.get(iface) ?? [];
  }

  private relayHost(): DhcpRelayHost {
    return {
      deviceId: this.deps.deviceId,
      hostname: () => this.deps.hostname(),
      bus: () => this.deps.bus(),
      interfaceAddress: (iface) => {
        const ip = this.deps.interfaceAddress(iface)?.ip;
        return ip ? new IPAddress(ip) : null;
      },
      interfaceOwning: (address) => this.deps.interfaceOwning?.(address) ?? null,
      sendToServer: (server, packet) => this.deps.sendToServer?.(server, packet) ?? false,
      broadcastReply: (iface, reply) => { this.deliver(iface, reply, { kind: 'broadcast' }); },
      relayInformationOption: () => false,
      countForward: () => undefined,
      countReply: () => undefined,
      countDrop: () => undefined,
    };
  }

  handleUdp(iface: string, packet: IPv4Packet, udp: UDPPacket): boolean {
    if (udp.destinationPort !== DHCP_SERVER_PORT) return false;

    const request = udp.payload as DHCPPacket | undefined;
    if (!request) return true;
    if (request.op === 2) {
      relayDhcpReply(this.relayHost(), request);
      return true;
    }
    if (request.op !== 1) return true;
    const relayServers = this.relays.get(iface);
    if (relayServers) {
      relayDhcpRequest(this.relayHost(), iface, request, relayServers);
      return true;
    }
    if (!this.server.isEnabled() || !this.scopeOfInterface(iface)) return true;

    const local = this.deps.interfaceAddress(iface);
    this.server.setServerIdentifier(local?.ip ?? '0.0.0.0');

    const reply = buildDhcpServerReply(request, {
      server: this.server,
      localGatewayIP: local?.ip,
      isAddressInUse: (address) => this.probeOnLink(iface, address),
    });
    if (reply) this.deliver(iface, reply, dhcpReplyRoute(request, reply), request.chaddr);
    return true;
  }

  private poolSubnet(scope: DhcpScope): { network: string; mask: string } | null {
    const local = this.deps.interfaceAddress(scope.iface);
    const mask = scope.netmask !== '0.0.0.0' && scope.netmask.length > 0
      ? scope.netmask
      : local?.mask ?? '255.255.255.0';
    const anchor = scope.ranges[0]?.startIp ?? local?.ip;
    if (!anchor) return null;

    const network = networkOf(anchor, mask);
    return network === null ? null : { network, mask };
  }

  private probeOnLink(iface: string, address: string): boolean {
    const local = this.deps.interfaceAddress(iface);
    if (local === undefined || !inSameSubnet(local.ip, address, local.mask)) return false;
    return this.deps.addressInUse?.(iface, address) ?? false;
  }

  private declarePool(scope: DhcpScope): void {
    const subnet = this.poolSubnet(scope);
    if (subnet === null) return;

    const { network, mask } = subnet;
    const local = this.deps.interfaceAddress(scope.iface);
    const name = poolNameOf(scope);
    this.server.createPool(name);
    this.server.configurePoolNetwork(name, network, mask);
    if (scope.defaultGateway !== '0.0.0.0' && scope.defaultGateway.length > 0) {
      this.server.configurePoolRouter(name, scope.defaultGateway);
    }
    const dns = this.resolvedDnsServers(scope, local?.ip);
    if (dns.length > 0) this.server.configurePoolDNS(name, dns);
    if (scope.domain.length > 0) this.server.configurePoolDomain(name, scope.domain);
    if (scope.leaseTimeSec === UNLIMITED_LEASE) this.server.configurePoolLeaseInfinite(name);
    else this.server.configurePoolLease(name, scope.leaseTimeSec);
    if (scope.conflictedIpTimeoutSec !== undefined) {
      this.server.configurePoolConflictTtl(name, scope.conflictedIpTimeoutSec);
    }

    for (const gap of gapsOutsideRanges(network, mask, scope.ranges)) {
      this.server.addExcludedRange(gap.start, gap.end);
    }

    for (const reservation of scope.reservations ?? []) {
      if (reservation.mac.length === 0 || reservation.ip === '0.0.0.0') continue;
      this.server.addStaticBinding(name, new MACAddress(reservation.mac).toString(), reservation.ip);
    }

    this.server.configurePoolUtilizationMark(name, 'high', POOL_USAGE_TRAP_PERCENT, false);
    this.server.configurePoolUtilizationMark(name, 'low', POOL_USAGE_TRAP_PERCENT - 1, false);
  }

  scopeOfPool(pool: string): DhcpScope | undefined {
    return [...this.scopes.values()].find((scope) => poolNameOf(scope) === pool);
  }

  leaseUsage(): ReadonlyArray<{ readonly scope: DhcpScope; readonly percent: number }> {
    return [...this.scopes.values()].map((scope) => {
      const pool = this.server.getAllPools().get(poolNameOf(scope));
      return { scope, percent: pool === undefined ? 0 : this.server.poolUtilizationPercent(pool) };
    });
  }

  private deliver(
    iface: string, reply: DHCPPacket, route: DhcpReplyRoute, clientMac: string = reply.chaddr,
  ): void {
    const source = new IPAddress(this.deps.interfaceAddress(iface)?.ip ?? '0.0.0.0');
    if (route.kind === 'relay') {
      const relay = new IPAddress(route.relay);
      this.deps.sendToServer?.(relay, buildUdpOverIpv4(source, {
        destination: relay,
        sourcePort: DHCP_SERVER_PORT, destinationPort: DHCP_SERVER_PORT,
        payload: reply, payloadBytes: DHCP_WIRE_BYTES,
      }));
      return;
    }
    const mac = this.deps.portMac(iface);
    if (!mac) return;

    this.deps.sendFrame(iface, dhcpServerReplyFrame(reply, source, mac, dhcpLinkDestination(route, clientMac)));
  }
}

function networkOf(address: string, mask: string): string | null {
  const value = tryIpToUint32(address);
  const bits = tryIpToUint32(mask);
  if (value === null || bits === null) return null;
  return uint32ToIp(((value & bits) >>> 0));
}

function gapsOutsideRanges(
  network: string, mask: string,
  ranges: ReadonlyArray<{ startIp: string; endIp: string }>,
): Array<{ start: string; end: string }> {
  const base = ipToUint32(network);
  const bits = ipToUint32(mask);
  const broadcast = (base | (~bits >>> 0)) >>> 0;

  const sorted = [...ranges]
    .map(range => ({ from: ipToUint32(range.startIp), to: ipToUint32(range.endIp) }))
    .filter(range => Number.isFinite(range.from) && Number.isFinite(range.to))
    .sort((left, right) => left.from - right.from);

  const gaps: Array<{ start: string; end: string }> = [];
  let cursor = base + 1;
  for (const range of sorted) {
    if (range.from > cursor) gaps.push({ start: uint32ToIp(cursor), end: uint32ToIp(range.from - 1) });
    cursor = Math.max(cursor, range.to + 1);
  }
  if (cursor <= broadcast - 1) {
    gaps.push({ start: uint32ToIp(cursor), end: uint32ToIp(broadcast - 1) });
  }
  return gaps;
}

export function dhcpDatagram(packet: IPv4Packet): UDPPacket | null {
  const payload = packet.payload as { type?: string; destinationPort?: number } | undefined;
  if (payload?.type !== 'udp') return null;
  if (payload.destinationPort !== DHCP_SERVER_PORT) return null;
  return packet.payload as UDPPacket;
}

export function dhcpReplyDatagram(packet: IPv4Packet): UDPPacket | null {
  const payload = packet.payload as { type?: string; destinationPort?: number } | undefined;
  if (payload?.type !== 'udp') return null;
  if (payload.destinationPort !== DHCP_CLIENT_PORT) return null;
  return packet.payload as UDPPacket;
}

export interface DhcpWiringHost {
  readonly deviceId: string;
  now(): number;
  hostname(): string;
  bus(): IEventBus;
  interfaceAddress(iface: string): { ip: string; mask: string } | undefined;
  portMac(iface: string): MACAddress | undefined;
  emitFrame(iface: string, frame: EthernetFrame): void;
  leaseGranted(iface: string, ip: string, mask: string): void;
  leaseRoute(iface: string, gateway: string | null, distance: number): void;
  leaseLost(iface: string): void;
  systemDnsServers?(): readonly string[];
  sendToServer?(server: IPAddress, packet: IPv4Packet): boolean;
  interfaceOwning?(address: string): string | null;
  addressInUse?(iface: string, address: string): boolean;
}

export function createFirewallDhcp(host: DhcpWiringHost): FirewallDhcp {
  return new FirewallDhcp({
    systemDnsServers: () => host.systemDnsServers?.() ?? [],
    deviceId: host.deviceId,
    now: () => host.now(),
    hostname: () => host.hostname(),
    bus: () => host.bus(),
    interfaceAddress: (iface) => host.interfaceAddress(iface),
    portMac: (iface) => host.portMac(iface),
    sendFrame: (iface, frame) => { host.emitFrame(iface, frame); },
    configureInterface: (iface, ip, mask) => { host.leaseGranted(iface, ip, mask); },
    installLeaseRoute: (iface, gateway, distance) => { host.leaseRoute(iface, gateway, distance); },
    clearInterface: (iface) => { host.leaseLost(iface); },
    sendToServer: (server, packet) => host.sendToServer?.(server, packet) ?? false,
    interfaceOwning: (address) => host.interfaceOwning?.(address) ?? null,
    addressInUse: (iface, address) => host.addressInUse?.(iface, address) ?? false,
  });
}
