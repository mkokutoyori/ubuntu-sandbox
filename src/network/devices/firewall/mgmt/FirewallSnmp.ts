import { SnmpAgent } from '../../../snmp/SnmpAgent';
import type { MibViewEntry } from '../../../snmp/mibView';
import type { SnmpCommunityAcl, SnmpValue, SnmpVersion } from '../../../snmp/types';
import { IPAddress, IP_PROTO_UDP, type EthernetFrame, type IPv4Packet, type SubnetMask, type UDPPacket } from '../../../core/types';
import type { PortNumber } from '../../../core/ports/PortNumber';
import type { Port } from '../../../hardware/Port';
import type { UdpSendRequest } from '../../../layers/transport/UdpEgress';
import type { IEventBus } from '@/events/EventBus';
import type { IScheduler } from '@/events/Scheduler';

export interface SnmpSysinfoSettings {
  readonly enabled: boolean;
  readonly description: string;
  readonly contactInfo: string;
  readonly location: string;
}

export const SNMP_SYSINFO_DEFAULTS: SnmpSysinfoSettings = Object.freeze({
  enabled: false, description: '', contactInfo: '', location: '',
});

export type SnmpManagerHostType = 'any' | 'query' | 'trap';

export interface SnmpManagerHost {
  readonly id: string;
  readonly address: IPAddress;
  readonly mask: SubnetMask;
  readonly hostType: SnmpManagerHostType;
  readonly haDirect: boolean;
}

export interface SnmpQueryAccess {
  readonly enabled: boolean;
  readonly port: PortNumber;
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
}

export interface SnmpMibViewSettings {
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export interface FirewallSnmpIdentity {
  readonly sysObjectId: string;
  readonly objects: ReadonlyMap<string, () => SnmpValue>;
}

export interface FirewallSnmpHost {
  readonly deviceId: string;
  readonly deviceName: string;
  hostname(): string;
  port(name: string): Port | undefined;
  ports(): Port[];
  sendFrame(name: string, frame: EthernetFrame): void;
  sendUdpDatagram(request: UdpSendRequest): boolean;
  bus(): IEventBus;
  scheduler(): IScheduler;
  identity(): FirewallSnmpIdentity;
  vdomOfInterface(name: string): string;
  interfaceDescription(name: string): string;
  haManagementInterfaces(): readonly string[];
}

const COMMUNITY_ACL_PREFIX = 'community:';

export class FirewallSnmp {
  private readonly agent: SnmpAgent;
  private sysinfo: SnmpSysinfoSettings = SNMP_SYSINFO_DEFAULTS;
  private readonly communities = new Map<string, SnmpCommunitySettings>();
  private readonly views = new Map<string, SnmpMibViewSettings>();

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
