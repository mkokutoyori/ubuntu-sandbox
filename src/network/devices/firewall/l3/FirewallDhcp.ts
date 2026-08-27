import {
  ETHERTYPE_IPV4, IPAddress, MACAddress, createIPv4Packet,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
} from '../../../core/types';
import { ipToUint32, tryIpToUint32, uint32ToIp } from '../../../core/ip';
import { DHCPServer } from '../../../dhcp/DHCPServer';
import { DHCPClient } from '../../../dhcp/DHCPClient';
import { WireDhcpChannel } from '../../../dhcp/DhcpServerChannel';
import { DHCPPacket } from '../../../dhcp/DHCPPacket';
import { buildDhcpServerReply } from '../../../dhcp/DhcpServerExchange';
import type { IEventBus } from '../../../../events/EventBus';

export const DHCP_SERVER_PORT = 67;
export const DHCP_CLIENT_PORT = 68;

export interface DhcpScope {
  readonly id: string;
  readonly enabled: boolean;
  readonly iface: string;
  readonly defaultGateway: string;
  readonly netmask: string;
  readonly dnsServers: readonly string[];
  readonly domain: string;
  readonly leaseTimeSec: number;
  readonly ranges: ReadonlyArray<{ startIp: string; endIp: string }>;
  readonly dnsService?: string;
  readonly reservations?: ReadonlyArray<{
    ip: string; mac: string; description: string;
  }>;
}

export interface FirewallDhcpDeps {
  readonly deviceId: string;
  readonly hostname: () => string;
  readonly bus: () => IEventBus;
  readonly interfaceAddress: (iface: string) => { ip: string; mask: string } | undefined;
  readonly portMac: (iface: string) => MACAddress | undefined;
  readonly sendFrame: (iface: string, frame: EthernetFrame) => void;
  readonly configureInterface: (
    iface: string, ip: string, mask: string, gateway: string | null) => void;
  readonly clearInterface: (iface: string) => void;
  readonly systemDnsServers?: () => readonly string[];
}

export class FirewallDhcp {
  private readonly server = new DHCPServer();
  private readonly scopes = new Map<string, DhcpScope>();
  private readonly client: DHCPClient;
  private readonly channels = new Map<string, WireDhcpChannel>();

  constructor(private readonly deps: FirewallDhcpDeps) {
    this.server.setDeviceId(deps.deviceId, deps.hostname());
    this.server.setEventBus(deps.bus());
    this.client = new DHCPClient(
      (iface) => deps.portMac(iface)?.toString() ?? '00:00:00:00:00:00',
      (iface, ip, mask, gateway) => { deps.configureInterface(iface, ip, mask, gateway); },
      (iface) => { deps.clearInterface(iface); });
    this.client.setDeviceId(deps.deviceId, deps.hostname());
    this.client.setEventBus(deps.bus());
    this.client.setWireChannelFactory((iface) => this.channelFor(iface));
  }

  acquireLease(iface: string): string {
    return this.client.requestLease(iface, {});
  }

  releaseLease(iface: string): void {
    this.channels.delete(iface);
  }

  private channelFor(iface: string): WireDhcpChannel {
    const existing = this.channels.get(iface);
    if (existing) return existing;

    const channel = new WireDhcpChannel(iface, (name, pkt) => {
      this.emitClientFrame(name, pkt);
    });
    this.channels.set(iface, channel);
    return channel;
  }

  private emitClientFrame(iface: string, pkt: DHCPPacket): void {
    const mac = this.deps.portMac(iface);
    if (!mac) return;

    const udp: UDPPacket = {
      type: 'udp',
      sourcePort: DHCP_CLIENT_PORT,
      destinationPort: DHCP_SERVER_PORT,
      length: 0,
      checksum: 0,
      payload: pkt,
    };

    this.deps.sendFrame(iface, {
      srcMAC: mac,
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: createIPv4Packet(
        new IPAddress('0.0.0.0'), new IPAddress('255.255.255.255'), 17, 1, udp, 64),
    });
  }

  deliverToClient(iface: string, udp: UDPPacket, sourceMac: string): boolean {
    if (udp.destinationPort !== DHCP_CLIENT_PORT) return false;

    const reply = udp.payload as DHCPPacket | undefined;
    if (!reply || reply.op !== 2) return true;

    this.channels.get(iface)?.deliver(reply, sourceMac);
    return true;
  }

  leases(): ReadonlyArray<{
    iface: string; ip: string; mac: string; expiresAt: number; serverId: string;
  }> {
    const found: Array<{
      iface: string; ip: string; mac: string; expiresAt: number; serverId: string;
    }> = [];
    for (const [ip, binding] of this.server.getBindings()) {
      const scope = [...this.scopes.values()]
        .find(entry => `scope-${entry.id}` === binding.poolName);
      found.push({
        iface: scope?.iface ?? '',
        ip,
        mac: binding.clientId,
        expiresAt: binding.leaseExpiration,
        serverId: scope?.id ?? '0',
      });
    }
    return found;
  }

  upsertScope(scope: DhcpScope): void {
    this.scopes.set(scope.id, scope);
    this.rebuild();
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

  getServer(): DHCPServer { return this.server; }

  scopeOfInterface(iface: string): DhcpScope | undefined {
    for (const scope of this.scopes.values()) {
      if (scope.enabled && scope.iface === iface && scope.ranges.length > 0) return scope;
    }
    return undefined;
  }

  handleUdp(iface: string, packet: IPv4Packet, udp: UDPPacket): boolean {
    if (udp.destinationPort !== DHCP_SERVER_PORT) return false;

    const request = udp.payload as DHCPPacket | undefined;
    if (!request || request.op !== 1) return true;
    if (!this.server.isEnabled() || !this.scopeOfInterface(iface)) return true;

    const local = this.deps.interfaceAddress(iface);
    this.server.setServerIdentifier(local?.ip ?? '0.0.0.0');

    const reply = buildDhcpServerReply(request, {
      server: this.server,
      localGatewayIP: local?.ip,
    });
    if (reply) this.emit(iface, reply, request.chaddr);
    return true;
  }

  private declarePool(scope: DhcpScope): void {
    const local = this.deps.interfaceAddress(scope.iface);
    const mask = scope.netmask !== '0.0.0.0' && scope.netmask.length > 0
      ? scope.netmask
      : local?.mask ?? '255.255.255.0';
    const anchor = scope.ranges[0]?.startIp ?? local?.ip;
    if (!anchor) return;

    const network = networkOf(anchor, mask);
    if (network === null) return;

    const name = `scope-${scope.id}`;
    this.server.createPool(name);
    this.server.configurePoolNetwork(name, network, mask);
    if (scope.defaultGateway !== '0.0.0.0' && scope.defaultGateway.length > 0) {
      this.server.configurePoolRouter(name, scope.defaultGateway);
    }
    const dns = this.resolvedDnsServers(scope, local?.ip);
    if (dns.length > 0) this.server.configurePoolDNS(name, dns);
    if (scope.domain.length > 0) this.server.configurePoolDomain(name, scope.domain);
    this.server.configurePoolLease(name, scope.leaseTimeSec);

    for (const gap of gapsOutsideRanges(network, mask, scope.ranges)) {
      this.server.addExcludedRange(gap.start, gap.end);
    }

    for (const reservation of scope.reservations ?? []) {
      if (reservation.mac.length === 0 || reservation.ip === '0.0.0.0') continue;
      this.server.addStaticBinding(name, reservation.mac, reservation.ip);
    }
  }

  private emit(iface: string, reply: DHCPPacket, clientMac: string): void {
    const source = this.deps.interfaceAddress(iface)?.ip ?? '0.0.0.0';
    const mac = this.deps.portMac(iface);
    if (!mac) return;

    const udp: UDPPacket = {
      type: 'udp',
      sourcePort: DHCP_SERVER_PORT,
      destinationPort: DHCP_CLIENT_PORT,
      length: 0,
      checksum: 0,
      payload: reply,
    };

    this.deps.sendFrame(iface, {
      srcMAC: mac,
      dstMAC: new MACAddress(clientMac),
      etherType: ETHERTYPE_IPV4,
      payload: createIPv4Packet(
        new IPAddress(source), new IPAddress('255.255.255.255'), 17, 1, udp, 64),
    });
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
  hostname(): string;
  bus(): IEventBus;
  interfaceAddress(iface: string): { ip: string; mask: string } | undefined;
  portMac(iface: string): MACAddress | undefined;
  emitFrame(iface: string, frame: EthernetFrame): void;
  leaseGranted(iface: string, ip: string, mask: string, gateway: string | null): void;
  leaseLost(iface: string): void;
  systemDnsServers?(): readonly string[];
}

export function createFirewallDhcp(host: DhcpWiringHost): FirewallDhcp {
  return new FirewallDhcp({
    systemDnsServers: () => host.systemDnsServers?.() ?? [],
    deviceId: host.deviceId,
    hostname: () => host.hostname(),
    bus: () => host.bus(),
    interfaceAddress: (iface) => host.interfaceAddress(iface),
    portMac: (iface) => host.portMac(iface),
    sendFrame: (iface, frame) => { host.emitFrame(iface, frame); },
    configureInterface: (iface, ip, mask, gateway) => {
      host.leaseGranted(iface, ip, mask, gateway);
    },
    clearInterface: (iface) => { host.leaseLost(iface); },
  });
}
