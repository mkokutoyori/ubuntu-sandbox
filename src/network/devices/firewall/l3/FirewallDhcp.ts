import {
  IPAddress, MACAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
} from '../../../core/types';
import { buildUdpOverIpv4 } from '../../../layers/transport/UdpEgress';
import { inSameSubnet, ipToUint32, isValidIPv4, tryIpToUint32, uint32ToIp } from '../../../core/ip';
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
import type { FirewallDdns, DdnsSettings } from './FirewallDdns';
import type { DhcpDebug } from './DhcpDebug';
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
  readonly ranges: ReadonlyArray<{ startIp: string; endIp: string; leaseTimeSec?: number }>;
  readonly dnsService?: string;
  readonly ntpService?: string;
  readonly ntpServers?: readonly string[];
  readonly winsServers?: readonly string[];
  readonly nextServer?: string;
  readonly bootFile?: string;
  readonly macAclDefaultAction?: 'assign' | 'block';
  readonly wifiControllers?: readonly string[];
  readonly ddns?: { readonly enabled: boolean; readonly override: boolean; readonly ttl: number } & DdnsSettings;
  readonly vciMatch?: boolean;
  readonly vciStrings?: readonly string[];
  readonly excludeRanges?: ReadonlyArray<{ startIp: string; endIp: string }>;
  readonly options?: ReadonlyArray<{
    id: string; code: number; type: string; value: string; ips: readonly string[];
  }>;
  readonly reservations?: ReadonlyArray<{
    id: string; ip: string; mac: string; description: string; action?: string;
    type?: 'mac' | 'option82'; circuitId?: string; circuitIdType?: string; remoteId?: string; remoteIdType?: string;
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
  readonly systemNtpServers?: () => readonly string[];
  readonly sendToServer?: (server: IPAddress, packet: IPv4Packet) => boolean;
  readonly interfaceOwning?: (address: string) => string | null;
  readonly ownAddresses?: () => readonly string[];
  readonly ddns?: () => FirewallDdns | undefined;
  readonly debug?: () => DhcpDebug | undefined;
  readonly addressInUse?: (iface: string, address: string) => boolean;
}

export interface DhcpClientRoute {
  readonly gateway: boolean;
  readonly distance: number;
}

const DEFAULT_CLIENT_ROUTE: DhcpClientRoute = { gateway: true, distance: 5 };
const POOL_USAGE_TRAP_PERCENT = 90;
const UNLIMITED_LEASE = 0;
const NTP_SERVERS_OPTION = 42;
const WIFI_CONTROLLER_OPTION = 138;

function poolNameOf(scope: DhcpScope): string {
  return `scope-${scope.id}`;
}

export function dhcpServerId(scope: DhcpScope): number | null {
  const id = Number.parseInt(scope.id, 10);
  return Number.isInteger(id) ? id : null;
}

export class FirewallDhcp {
  private readonly relays = new Map<string, readonly string[]>();
  private readonly relayOptionInterfaces = new Set<string>();
  private relayingFrom: string | null = null;
  private readonly registeredNames = new Map<string, { fqdn: string; scope: DhcpScope }>();

  private readonly server = new DHCPServer();
  private readonly scopes = new Map<string, DhcpScope>();
  private readonly client: DHCPClient;
  private readonly channels = new Map<string, WireDhcpChannel>();

  constructor(private readonly deps: FirewallDhcpDeps) {
    this.server.setDeviceId(deps.deviceId, deps.hostname());
    this.server.setEventBus(deps.bus());
    this.server.setClock(deps.now);
    deps.bus().subscribe('dhcp.pool.lease-released', (event) => {
      if (event.payload.deviceId === deps.deviceId) this.withdrawName(event.payload.ip);
    });
    this.server.setAdmissionPolicy({
      mayServe: (mac, pool, client) => this.macAclAllows(mac, pool, client?.relayInformation) && this.vendorClassAllows(client?.vendorClass, pool),
      addressAllowed: () => true,
      leaseSeconds: (pool, configured, address) => this.rangeLeaseSeconds(pool, configured, address),
    });
    this.traceClientAndRelay();
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

  private traceClientAndRelay(): void {
    const bus = this.deps.bus();
    const client = (text: string): void => this.deps.debug?.()?.emit('dhcpc', text);
    const relay = (text: string): void => this.deps.debug?.()?.emit('dhcprelay', text);
    bus.subscribe('dhcp.discover.sent', (event) => {
      if (event.payload.deviceId === this.deps.deviceId) client(`DHCPDISCOVER on ${event.payload.iface} to 255.255.255.255 port 67`);
    });
    bus.subscribe('dhcp.offer.received', (event) => {
      if (event.payload.deviceId === this.deps.deviceId) client(`DHCPOFFER of ${event.payload.offeredIp} from ${event.payload.serverIp}`);
    });
    bus.subscribe('dhcp.request.sent', (event) => {
      if (event.payload.deviceId === this.deps.deviceId) client(`DHCPREQUEST for ${event.payload.requestedIp} on ${event.payload.iface} to ${event.payload.serverIp} port 67`);
    });
    bus.subscribe('dhcp.ack.received', (event) => {
      if (event.payload.deviceId !== this.deps.deviceId) return;
      client(`DHCPACK of ${event.payload.assignedIp} from ${event.payload.serverIp}`);
      client(`bound to ${event.payload.assignedIp} -- renewal in ${event.payload.t1Sec} seconds.`);
    });
    bus.subscribe('dhcp.nak.received', (event) => {
      if (event.payload.deviceId === this.deps.deviceId) client(`DHCPNAK from ${event.payload.serverIp}`);
    });
    bus.subscribe('dhcp.decline.sent', (event) => {
      if (event.payload.deviceId === this.deps.deviceId) client(`DHCPDECLINE of ${event.payload.ip} on ${event.payload.iface} to ${event.payload.serverIp} port 67`);
    });
    bus.subscribe('dhcp.lease.renewing', (event) => {
      if (event.payload.deviceId === this.deps.deviceId) client(`DHCPREQUEST for ${event.payload.ip} on ${event.payload.iface} (renewing)`);
    });
    bus.subscribe('dhcp.relay.forwarded', (event) => {
      if (event.payload.deviceId !== this.deps.deviceId) return;
      for (const helper of event.payload.helpers) relay(`Forwarded BOOTREQUEST for ${event.payload.clientMac} to ${helper}`);
    });
    bus.subscribe('dhcp.relay.reply-forwarded', (event) => {
      if (event.payload.deviceId === this.deps.deviceId) relay(`Forwarded BOOTREPLY for ${event.payload.clientMac} to ${event.payload.assignedIp}`);
    });
    bus.subscribe('dhcp.relay.dropped', (event) => {
      if (event.payload.deviceId === this.deps.deviceId) relay(`Discarding packet with hop count ${event.payload.hops} from ${event.payload.clientMac}`);
    });
  }

  private traceServer(iface: string, request: DHCPPacket, reply: DHCPPacket | null): void {
    const debug = this.deps.debug?.();
    if (debug === undefined || debug.level('dhcps') === 0) return;
    const mac = request.chaddr.toLowerCase();
    const via = request.giaddr !== '0.0.0.0' ? request.giaddr : `${iface}(ethernet)`;
    const replied = reply?.getMessageType();
    const say = (text: string): void => debug.emit('dhcps', text);
    switch (request.getMessageType()) {
      case 'DHCPDISCOVER':
        say(`DHCPDISCOVER from ${mac} via ${via}`);
        if (replied === 'DHCPOFFER') say(`DHCPOFFER on ${reply!.yiaddr} to ${mac} via ${via}`);
        else say(`DHCPDISCOVER from ${mac} via ${via}: no free leases`);
        break;
      case 'DHCPREQUEST': {
        const wanted = String(request.getOption(50) ?? request.ciaddr);
        say(`DHCPREQUEST for ${wanted} from ${mac} via ${via}`);
        if (replied === 'DHCPACK') say(`DHCPACK on ${reply!.yiaddr} to ${mac} via ${via}`);
        else if (replied === 'DHCPNAK') say(`DHCPNAK on ${wanted} to ${mac} via ${via}`);
        break;
      }
      case 'DHCPRELEASE': say(`DHCPRELEASE of ${request.ciaddr} from ${mac} via ${via}`); break;
      case 'DHCPDECLINE': say(`DHCPDECLINE of ${String(request.getOption(50) ?? request.ciaddr)} from ${mac} via ${via}`); break;
      case 'DHCPINFORM': say(`DHCPINFORM from ${request.ciaddr} via ${via}`); break;
      default: break;
    }
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

  setClientOptions(iface: string, options: { identifier: string; renewTimeSec: number }): void {
    this.client.setClientIdentifier(iface, options.identifier);
    this.client.setRenewTime(iface, options.renewTimeSec);
  }

  setRelayAgentOption(iface: string, on: boolean): void {
    if (on) this.relayOptionInterfaces.add(iface);
    else this.relayOptionInterfaces.delete(iface);
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
        mac: binding.clientId.startsWith('id:') ? binding.clientId : new MACAddress(binding.clientId).toString(),
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
      if (!isFixedReservation(reservation)) continue;
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

  private resolvedNtpServers(scope: DhcpScope, localIp?: string): string[] {
    if (scope.ntpService === 'local') return localIp ? [localIp] : [];
    if (scope.ntpService === 'default') return (this.deps.systemNtpServers?.() ?? []).filter(isValidIPv4);
    return [...(scope.ntpServers ?? [])];
  }

  private registerName(iface: string, request: DHCPPacket, reply: DHCPPacket): void {
    if (reply.getMessageType() !== 'DHCPACK') return;
    const scope = this.scopeOfInterface(iface);
    const ddns = this.deps.ddns?.();
    if (scope?.ddns === undefined || !scope.ddns.enabled || ddns === undefined) return;
    const fqdnOption = request.getOption(81) as { flags: number; name: string } | undefined;
    if (fqdnOption !== undefined && (fqdnOption.flags & 0x01) === 0 && !scope.ddns.override) return;
    const declared = String(request.getOption(12) ?? fqdnOption?.name ?? '').trim();
    if (declared.length === 0) return;
    const fqdn = `${declared.split('.')[0]}.${scope.ddns.zone}`;
    if (ddns.register(scope.ddns, fqdn, reply.yiaddr, scope.ddns.ttl)) {
      this.registeredNames.set(reply.yiaddr, { fqdn, scope });
    }
  }

  private withdrawName(address: string): void {
    const held = this.registeredNames.get(address);
    const ddns = this.deps.ddns?.();
    if (held === undefined || held.scope.ddns === undefined || ddns === undefined) return;
    this.registeredNames.delete(address);
    ddns.withdraw(held.scope.ddns, held.fqdn, address);
  }

  private vendorClassAllows(vendorClass: string | undefined, pool: string): boolean {
    const scope = this.scopeOfPool(pool);
    if (scope === undefined || scope.vciMatch !== true) return true;
    if (vendorClass === undefined) return false;
    return (scope.vciStrings ?? []).some(candidate => vendorClass.startsWith(candidate));
  }

  private rangeLeaseSeconds(pool: string, configured: number, address: string | undefined): number {
    const scope = this.scopeOfPool(pool);
    if (scope === undefined || address === undefined) return configured;
    const value = ipToUint32(address);
    for (const range of scope.ranges) {
      if (range.leaseTimeSec === undefined || range.leaseTimeSec === 0) continue;
      if (value >= ipToUint32(range.startIp) && value <= ipToUint32(range.endIp)) return range.leaseTimeSec;
    }
    return configured;
  }

  private option82Entry(scope: DhcpScope, information: { circuitId: string; remoteId: string } | undefined) {
    if (information === undefined) return undefined;
    return (scope.reservations ?? []).find(reservation => {
      if (reservation.type !== 'option82') return false;
      const circuit = decodedOption82(reservation.circuitId ?? '', reservation.circuitIdType);
      const remote = decodedOption82(reservation.remoteId ?? '', reservation.remoteIdType);
      return (circuit === '' || circuit === information.circuitId) && (remote === '' || remote === information.remoteId)
        && (circuit !== '' || remote !== '');
    });
  }

  private macAclAllows(clientMac: string, pool: string, information?: { circuitId: string; remoteId: string }): boolean {
    const scope = this.scopeOfPool(pool);
    if (scope === undefined) return true;
    const relayed = this.option82Entry(scope, information);
    if (relayed !== undefined) {
      this.applyOption82Reservation(pool, clientMac, relayed);
      return relayed.action !== 'block';
    }
    if (clientMac.startsWith('id:')) return scope.macAclDefaultAction !== 'block';
    const mac = new MACAddress(clientMac).toString();
    const entry = (scope.reservations ?? []).find(reservation =>
      reservation.type !== 'option82' && reservation.mac.length > 0 && new MACAddress(reservation.mac).toString() === mac);
    if (entry !== undefined) return entry.action !== 'block';
    return scope.macAclDefaultAction !== 'block';
  }

  private applyOption82Reservation(pool: string, clientMac: string, entry: { ip: string; action?: string }): void {
    if ((entry.action ?? 'reserved') !== 'reserved' || entry.ip === '0.0.0.0' || clientMac.startsWith('id:')) return;
    const mac = new MACAddress(clientMac).toString();
    for (const held of this.server.getStaticBindings(pool)) {
      if (held.clientId === mac) this.server.removeStaticBinding(pool, held.ipAddress);
    }
    this.server.addStaticBinding(pool, mac, entry.ip);
  }

  clearLease(ip: string): boolean {
    this.withdrawName(ip);
    return this.server.clearBinding(ip);
  }

  clearAllLeases(): void {
    for (const address of [...this.registeredNames.keys()]) this.withdrawName(address);
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
      relayInformationOption: () => this.relayingFrom !== null && this.relayOptionInterfaces.has(this.relayingFrom),
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
      this.relayingFrom = iface;
      relayDhcpRequest(this.relayHost(), iface, request, relayServers);
      this.relayingFrom = null;
      return true;
    }
    if (!this.server.isEnabled() || !this.scopeOfInterface(iface)) return true;

    const local = this.deps.interfaceAddress(iface);
    this.server.setServerIdentifier(local?.ip ?? '0.0.0.0');
    this.server.setServerOwnedAddresses([...(this.deps.ownAddresses?.() ?? [])]);

    const reply = buildDhcpServerReply(request, {
      server: this.server,
      localGatewayIP: local?.ip,
      isAddressInUse: (address) => this.probeOnLink(iface, address),
    });
    if (request.getMessageType() === 'DHCPRELEASE') this.withdrawName(request.ciaddr);
    this.traceServer(iface, request, reply ?? null);
    if (reply) {
      this.registerName(iface, request, reply);
      this.deliver(iface, reply, dhcpReplyRoute(request, reply), request.chaddr);
    }
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
    for (const range of scope.excludeRanges ?? []) {
      this.server.addExcludedRange(range.startIp, range.endIp);
    }

    const ntp = this.resolvedNtpServers(scope, local?.ip);
    if (ntp.length > 0) this.server.configurePoolOption(name, NTP_SERVERS_OPTION, 'ip', ntp.join(' '));
    if ((scope.winsServers ?? []).length > 0) this.server.configurePoolNetbios(name, [...scope.winsServers!]);
    if (scope.nextServer !== undefined && scope.nextServer !== '0.0.0.0' && scope.nextServer.length > 0) {
      this.server.configurePoolNextServer(name, scope.nextServer);
    }
    if ((scope.bootFile ?? '').length > 0) this.server.configurePoolBootfile(name, scope.bootFile!);
    if ((scope.wifiControllers ?? []).length > 0) {
      this.server.configurePoolOption(name, WIFI_CONTROLLER_OPTION, 'ip', scope.wifiControllers!.join(' '));
    }
    for (const option of scope.options ?? []) {
      const encoded = encodedOption(option);
      if (encoded !== null) this.server.configurePoolOption(name, option.code, encoded.kind, encoded.value);
    }

    for (const reservation of scope.reservations ?? []) {
      if (!isFixedReservation(reservation)) continue;
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

function isFixedReservation(reservation: { ip: string; mac: string; action?: string; type?: string }): boolean {
  return reservation.type !== 'option82' && reservation.mac.length > 0 && reservation.ip !== '0.0.0.0'
    && (reservation.action ?? 'reserved') === 'reserved';
}

function decodedOption82(value: string, type: string | undefined): string {
  if (type !== 'hex') return value;
  const digits = value.replace(/[^0-9a-fA-F]/g, '');
  let text = '';
  for (let i = 0; i + 1 < digits.length; i += 2) text += String.fromCharCode(parseInt(digits.slice(i, i + 2), 16));
  return text;
}

function domainSearchHex(name: string): string {
  const labels = name.split('.').filter(label => label.length > 0);
  const bytes: number[] = [];
  for (const label of labels) {
    bytes.push(label.length);
    for (const ch of label) bytes.push(ch.charCodeAt(0));
  }
  bytes.push(0);
  return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function encodedOption(
  option: { type: string; value: string; ips: readonly string[] },
): { kind: 'ip' | 'ascii' | 'hex'; value: string } | null {
  switch (option.type) {
    case 'ip': return option.ips.length > 0 ? { kind: 'ip', value: option.ips.join(' ') } : null;
    case 'string': return option.value.length > 0 ? { kind: 'ascii', value: option.value } : null;
    case 'fqdn': return option.value.length > 0 ? { kind: 'hex', value: domainSearchHex(option.value) } : null;
    default: return option.value.length > 0 ? { kind: 'hex', value: option.value } : null;
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
  systemNtpServers?(): readonly string[];
  sendToServer?(server: IPAddress, packet: IPv4Packet): boolean;
  interfaceOwning?(address: string): string | null;
  ownAddresses?(): readonly string[];
  ddns?(): FirewallDdns | undefined;
  debug?(): DhcpDebug | undefined;
  addressInUse?(iface: string, address: string): boolean;
}

export function createFirewallDhcp(host: DhcpWiringHost): FirewallDhcp {
  return new FirewallDhcp({
    systemDnsServers: () => host.systemDnsServers?.() ?? [],
    systemNtpServers: () => host.systemNtpServers?.() ?? [],
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
    ownAddresses: () => host.ownAddresses?.() ?? [],
    ddns: () => host.ddns?.(),
    debug: () => host.debug?.(),
    addressInUse: (iface, address) => host.addressInUse?.(iface, address) ?? false,
  });
}
