import { SnmpAgent } from '../../../snmp/SnmpAgent';
import type { MibViewEntry } from '../../../snmp/mibView';
import type { SnmpNotification } from '../../../snmp/SnmpNotification';
import type { SnmpCommunityAcl, SnmpValue, SnmpVersion } from '../../../snmp/types';
import { IPAddress, IP_PROTO_UDP, type EthernetFrame, type IPv4Packet, type SubnetMask, type UDPPacket } from '../../../core/types';
import type { PortNumber } from '../../../core/ports/PortNumber';
import type { Port } from '../../../hardware/Port';
import type { UdpSendRequest } from '../../../layers/transport/UdpEgress';
import type { IEventBus } from '@/events/EventBus';
import type { IScheduler } from '@/events/Scheduler';

export const SNMP_TRAP_EVENTS = Object.freeze([
  'cpu-high', 'mem-low', 'log-full', 'intf-ip', 'vpn-tun-up', 'vpn-tun-down', 'ha-switch', 'ha-hb-failure',
  'ips-signature', 'ips-anomaly', 'av-virus', 'av-oversize', 'av-pattern', 'av-fragmented', 'fm-if-change',
  'fm-conf-change', 'bgp-established', 'bgp-backward-transition', 'ha-member-up', 'ha-member-down',
  'ent-conf-change', 'av-conserve', 'av-bypass', 'av-oversize-passed', 'av-oversize-blocked', 'ips-pkg-update',
  'ips-fail-open', 'temperature-high', 'voltage-alert', 'power-supply', 'faz-disconnect', 'faz', 'fan-failure',
  'wc-ap-up', 'wc-ap-down', 'fswctl-session-up', 'fswctl-session-down', 'load-balance-real-server-down',
  'device-new', 'per-cpu-high', 'dhcp', 'pool-usage', 'ippool', 'interface', 'ospf-nbr-state-change',
  'ospf-virtnbr-state-change', 'enter-intf-bypass', 'exit-intf-bypass', 'dio',
] as const);

export type SnmpTrapEvent = typeof SNMP_TRAP_EVENTS[number];

export interface SnmpTrapThresholds {
  readonly freeMemoryPercent: number;
  readonly freeableMemoryPercent: number;
  readonly highCpuPercent: number;
  readonly logFullPercent: number;
  readonly lowMemoryPercent: number;
}

export interface SnmpSysinfoSettings {
  readonly enabled: boolean;
  readonly description: string;
  readonly contactInfo: string;
  readonly location: string;
  readonly thresholds: SnmpTrapThresholds;
}

export const SNMP_SYSINFO_DEFAULTS: SnmpSysinfoSettings = Object.freeze({
  enabled: false, description: '', contactInfo: '', location: '',
  thresholds: Object.freeze({
    freeMemoryPercent: 5, freeableMemoryPercent: 60, highCpuPercent: 80,
    logFullPercent: 90, lowMemoryPercent: 80,
  }),
});

export type SnmpManagerHostType = 'any' | 'query' | 'trap';

export type SnmpInterfaceSelectMethod = 'auto' | 'sdwan' | 'specify';

export interface SnmpManagerHost {
  readonly id: string;
  readonly address: IPAddress;
  readonly mask: SubnetMask;
  readonly hostType: SnmpManagerHostType;
  readonly haDirect: boolean;
  readonly source: IPAddress | null;
  readonly interfaceSelectMethod: SnmpInterfaceSelectMethod;
  readonly iface: string | null;
  readonly vrf: number;
}

export interface SnmpQueryAccess {
  readonly enabled: boolean;
  readonly port: PortNumber;
}

export interface SnmpTrapChannel {
  readonly enabled: boolean;
  readonly localPort: PortNumber;
  readonly remotePort: PortNumber;
}

export interface SnmpCommunitySettings {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly hosts: readonly SnmpManagerHost[];
  readonly queryV1: SnmpQueryAccess;
  readonly queryV2c: SnmpQueryAccess;
  readonly mibView: string;
  readonly vdoms: readonly string[];
  readonly events: readonly SnmpTrapEvent[];
  readonly trapV1: SnmpTrapChannel;
  readonly trapV2c: SnmpTrapChannel;
}

export interface SnmpMibViewSettings {
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export type MemoryTrapCondition = 'used-high' | 'free-low' | 'freeable-high';

export type FirewallTrapFact =
  | { readonly kind: 'link'; readonly port: string; readonly up: boolean }
  | { readonly kind: 'interface-address'; readonly port: string }
  | { readonly kind: 'cpu-high' }
  | { readonly kind: 'memory'; readonly condition: MemoryTrapCondition }
  | { readonly kind: 'log-disk-full' }
  | {
    readonly kind: 'vpn-tunnel'; readonly up: boolean; readonly phase1: string;
    readonly local: IPAddress; readonly remote: IPAddress;
  }
  | { readonly kind: 'ha-switch' }
  | { readonly kind: 'ha-member'; readonly up: boolean; readonly serial: string }
  | { readonly kind: 'ha-heartbeat-failure' }
  | { readonly kind: 'conserve-entered' }
  | { readonly kind: 'real-server-down'; readonly server: IPAddress; readonly virtualServer: string }
  | {
    readonly kind: 'anomaly'; readonly signatureId: number; readonly anomaly: string;
    readonly source: IPAddress;
  }
  | { readonly kind: 'virus'; readonly name: string }
  | { readonly kind: 'oversize'; readonly blocked: boolean }
  | { readonly kind: 'av-bypass' }
  | { readonly kind: 'ips-fail-open' };

export interface FirewallTrap {
  readonly event: SnmpTrapEvent | null;
  readonly notification: SnmpNotification;
}

export interface FirewallTrapContext {
  interfaceIndex(name: string): number | null;
  value(oid: string): SnmpValue | null;
  port(name: string): Port | undefined;
}

export interface FirewallSnmpIdentity {
  readonly sysObjectId: string;
  readonly objects: ReadonlyMap<string, () => SnmpValue>;
  traps(fact: FirewallTrapFact, context: FirewallTrapContext): readonly FirewallTrap[];
}

export interface FirewallLoadSample {
  readonly cpuPercent: number;
  readonly memoryUsedPercent: number;
  readonly memoryFreePercent: number;
  readonly memoryFreeablePercent: number;
  readonly logDiskPercent: number | null;
}

export interface FirewallSnmpHost {
  readonly deviceId: string;
  readonly deviceName: string;
  hostname(): string;
  port(name: string): Port | undefined;
  ports(): Port[];
  sendFrame(name: string, frame: EthernetFrame): void;
  sendUdpDatagram(request: UdpSendRequest): boolean;
  sourceAddressFor(destination: IPAddress, iface?: string): IPAddress | null;
  sdwanEgress(destination: IPAddress, sourcePort: PortNumber, destinationPort: PortNumber): string | null;
  vrfs(): readonly number[];
  bus(): IEventBus;
  scheduler(): IScheduler;
  identity(): FirewallSnmpIdentity;
  vdomOfInterface(name: string): string;
  interfaceDescription(name: string): string;
  haManagementInterfaces(): readonly string[];
}

const COMMUNITY_ACL_PREFIX = 'community:';
const SINGLE_HOST_PREFIX_LENGTH = 32;
const LOAD_EVENTS: readonly SnmpTrapEvent[] = Object.freeze(['cpu-high', 'mem-low', 'log-full']);

interface TrapEgress {
  readonly source?: IPAddress;
  readonly iface?: string;
}

export class FirewallSnmp {
  private readonly agent: SnmpAgent;
  private sysinfo: SnmpSysinfoSettings = SNMP_SYSINFO_DEFAULTS;
  private readonly communities = new Map<string, SnmpCommunitySettings>();
  private readonly views = new Map<string, SnmpMibViewSettings>();
  private readonly raisedConditions = new Set<string>();

  constructor(private readonly host: FirewallSnmpHost) {
    this.agent = new SnmpAgent({
      id: host.deviceId,
      name: host.deviceName,
      getHostname: () => host.hostname(),
      getPort: (name) => host.port(name),
      getPorts: () => host.ports(),
      sendFrame: (name, frame) => { host.sendFrame(name, frame); },
      getSysDescr: () => this.sysinfo.description,
      getSysObjectId: () => host.identity().sysObjectId,
      sendUdpDatagram: (request) => host.sendUdpDatagram(request),
      sourceAddressFor: (destination, iface) => host.sourceAddressFor(destination, iface),
      evaluateAclPermit: (aclName, source, inPort) => this.admits(aclName, source, inPort),
      describeInterface: (port) => ({
        descr: host.interfaceDescription(port.getName()), name: port.getName(),
      }),
    }, () => host.bus(), () => host.scheduler());
    for (const [oid, read] of host.identity().objects) this.agent.registerMib(oid, read);
    this.agent.start();
    this.project();
  }

  getAgent(): SnmpAgent { return this.agent; }

  getSysinfo(): SnmpSysinfoSettings { return this.sysinfo; }

  applySysinfo(settings: SnmpSysinfoSettings): void {
    this.sysinfo = settings;
    this.project();
  }

  applyCommunity(settings: SnmpCommunitySettings): void {
    this.communities.set(settings.id, settings);
    this.project();
  }

  removeCommunity(id: string): void {
    this.communities.delete(id);
    this.project();
  }

  applyMibView(view: SnmpMibViewSettings): void {
    this.views.set(view.name, view);
    this.project();
  }

  removeMibView(name: string): void {
    this.views.delete(name);
    this.project();
  }

  listensOn(packet: IPv4Packet): boolean {
    if (!this.sysinfo.enabled || packet.protocol !== IP_PROTO_UDP) return false;
    const udp = packet.payload as UDPPacket | undefined;
    if (udp?.type !== 'udp') return false;
    return [...this.communities.values()].some((community) => community.enabled
      && ((community.queryV1.enabled && community.queryV1.port.value === udp.destinationPort)
        || (community.queryV2c.enabled && community.queryV2c.port.value === udp.destinationPort)));
  }

  handleUdp(iface: string, packet: IPv4Packet): void {
    const udp = packet.payload as UDPPacket | undefined;
    if (udp?.type !== 'udp') return;
    this.agent.handleUdp(iface, packet.sourceIP, udp, packet.destinationIP);
  }

  raise(fact: FirewallTrapFact): void {
    if (!this.sysinfo.enabled) return;
    const context: FirewallTrapContext = {
      interfaceIndex: (name) => this.agent.interfaceIndexOf(name),
      value: (oid) => this.agent.getLocalOidValue(oid),
      port: (name) => this.host.port(name),
    };
    for (const trap of this.host.identity().traps(fact, context)) this.notify(trap.event, trap.notification);
  }

  watchesLoad(): boolean {
    return this.sysinfo.enabled && [...this.communities.values()].some((community) => community.enabled
      && (community.trapV1.enabled || community.trapV2c.enabled)
      && community.events.some((event) => LOAD_EVENTS.includes(event)));
  }

  observeLoad(sample: FirewallLoadSample): void {
    const thresholds = this.sysinfo.thresholds;
    this.crossing('cpu', sample.cpuPercent > thresholds.highCpuPercent, { kind: 'cpu-high' });
    this.crossing('memory-used', sample.memoryUsedPercent > thresholds.lowMemoryPercent,
      { kind: 'memory', condition: 'used-high' });
    this.crossing('memory-free', sample.memoryFreePercent < thresholds.freeMemoryPercent,
      { kind: 'memory', condition: 'free-low' });
    this.crossing('memory-freeable', sample.memoryFreeablePercent > thresholds.freeableMemoryPercent,
      { kind: 'memory', condition: 'freeable-high' });
    if (sample.logDiskPercent !== null) {
      this.crossing('log-disk', sample.logDiskPercent > thresholds.logFullPercent, { kind: 'log-disk-full' });
    }
  }

  private crossing(condition: string, exceeded: boolean, fact: FirewallTrapFact): void {
    if (!exceeded) {
      this.raisedConditions.delete(condition);
      return;
    }
    if (this.raisedConditions.has(condition)) return;
    this.raisedConditions.add(condition);
    this.raise(fact);
  }

  private notify(event: SnmpTrapEvent | null, notification: SnmpNotification): void {
    const stamped: SnmpNotification = { ...notification, v1Enterprise: this.host.identity().sysObjectId };
    for (const community of this.communities.values()) {
      if (!community.enabled || (event !== null && !community.events.includes(event))) continue;
      for (const manager of community.hosts) {
        const channels: ReadonlyArray<readonly [SnmpVersion, SnmpTrapChannel]> = [
          ['v1', community.trapV1], ['v2c', community.trapV2c],
        ];
        for (const [version, channel] of channels) {
          if (!channel.enabled) continue;
          const egress = this.trapEgress(manager, channel);
          if (egress === null) continue;
          this.agent.notify({
            version, community: community.name, destination: manager.address,
            destinationPort: channel.remotePort, sourcePort: channel.localPort, ...egress,
          }, stamped);
        }
      }
    }
  }

  private trapEgress(manager: SnmpManagerHost, channel: SnmpTrapChannel): TrapEgress | null {
    if (manager.hostType === 'query' || manager.mask.toCIDR() !== SINGLE_HOST_PREFIX_LENGTH) return null;
    if (!this.host.vrfs().includes(manager.vrf)) return null;
    const source = manager.source === null ? {} : { source: manager.source };
    if (manager.haDirect) {
      const reserved = this.host.haManagementInterfaces()[0];
      return reserved === undefined ? null : { ...source, iface: reserved };
    }
    if (manager.interfaceSelectMethod === 'specify') {
      return manager.iface === null ? null : { ...source, iface: manager.iface };
    }
    if (manager.interfaceSelectMethod === 'sdwan') {
      const steered = this.host.sdwanEgress(manager.address, channel.localPort, channel.remotePort);
      return steered === null ? source : { ...source, iface: steered };
    }
    return source;
  }

  private project(): void {
    this.agent.setEnabled(this.sysinfo.enabled);
    this.agent.setContact(this.sysinfo.contactInfo);
    this.agent.setLocation(this.sysinfo.location);
    this.agent.clearMibViews();
    const entries: SnmpCommunityAcl[] = [];
    for (const community of this.communities.values()) {
      if (!community.enabled) continue;
      const aclName = `${COMMUNITY_ACL_PREFIX}${community.id}`;
      const view = this.communityView(community);
      if (view) this.agent.setMibView(aclName, view);
      const queryPorts: Partial<Record<SnmpVersion, PortNumber>> = {};
      if (community.queryV1.enabled) queryPorts.v1 = community.queryV1.port;
      if (community.queryV2c.enabled) queryPorts.v2c = community.queryV2c.port;
      entries.push({
        community: community.name, access: 'ro', aclName,
        ...(view ? { viewName: aclName } : {}),
        ...(community.vdoms.length === 0 ? {} : { interfaceNames: this.interfacesOf(community.vdoms) }),
        queryPorts,
      });
    }
    this.agent.replaceCommunities(entries);
  }

  private communityView(community: SnmpCommunitySettings): MibViewEntry[] | null {
    if (community.mibView === '') return null;
    const configured = this.views.get(community.mibView);
    if (!configured) return [];
    return [
      ...configured.include.map((oid) => ({ oid, type: 'included' as const })),
      ...configured.exclude.map((oid) => ({ oid, type: 'excluded' as const })),
    ];
  }

  private interfacesOf(vdoms: readonly string[]): string[] {
    return this.host.ports().map((port) => port.getName())
      .filter((name) => vdoms.includes(this.host.vdomOfInterface(name)));
  }

  private admits(aclName: string, source: string, inPort: string): boolean {
    if (!aclName.startsWith(COMMUNITY_ACL_PREFIX)) return false;
    const community = this.communities.get(aclName.slice(COMMUNITY_ACL_PREFIX.length));
    if (!community) return false;
    const manager = new IPAddress(source);
    const reserved = this.host.haManagementInterfaces().includes(inPort);
    return community.hosts.some((host) => host.hostType !== 'trap'
      && host.haDirect === reserved
      && manager.isInSameSubnet(host.address, host.mask));
  }
}
