import { Equipment } from '../../equipment/Equipment';
import { Port } from '../../hardware/Port';
import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  IPAddress,
  MACAddress,
  SubnetMask,
  computeIPv4Checksum,
  type ARPPacket,
  type DeviceType,
  type EthernetFrame,
  type ICMPPacket,
  type IPv4Packet,
} from '../../core/types';
import { IP_PROTO_ICMP } from '../../core/types';
import { tryIpToUint32 } from '../../core/ip';
import { InterfaceTable, type InterfaceConfig } from './l3/InterfaceTable';
import { RouteTable } from './l3/RouteTable';
import { ArpService } from './l3/ArpService';
import { ZoneTable } from './model/ZoneTable';
import { ObjectStore } from './model/ObjectStore';
import { PolicyStore } from './model/PolicyStore';
import { PolicyEvaluator } from './policy/PolicyEvaluator';
import { SessionTable } from './session/SessionTable';
import { NatPolicyStore } from './nat/NatPolicyStore';
import { FirewallNatEngine } from './nat/FirewallNatEngine';
import { IpPoolAllocator, type IpPool } from './nat/IpPool';
import { PolicyRouteTable } from './l3/PolicyRouteTable';
import { FirewallPipeline, PipelineStageRegistry } from './pipeline/FirewallPipeline';
import { makePacketContext, type PacketContext } from './pipeline/PacketContext';
import { flowKeyFromPacket } from './session/FlowKey';
import { createCoreStages, type FirewallServices } from './pipeline/stages/coreStages';
import { buildSimulatedPacket } from './pipeline/SimulatedPacket';
import {
  UnknownSimulationInterfaceError,
  summariseSimulation,
  type SimulationRequest,
  type SimulationResult,
} from './pipeline/Simulation';
import { GENERIC_PROFILE, type FirewallProfile } from './FirewallProfile';
import { ScheduleStore, type ScheduleObject } from './model/ScheduleObject';
import { LoggingConfig } from '../inspection/config/LoggingConfig';
import { SyslogAgent } from '../../syslog/SyslogAgent';
import {
  projectLoggingOntoSyslogAgent,
  syslogSeverityOf,
} from '../../syslog/loggingProjection';
import {
  firewallLogText,
  type FirewallLogEvent,
  type FirewallLogFacts,
} from './logging/SyslogCatalog';

export interface FirewallOptions {
  profile?: FirewallProfile;
  now?: () => number;
}

export interface ProxyArpEntry {
  readonly from: string;
  readonly to?: string;
  readonly iface?: string;
}

export class Firewall extends Equipment {
  private readonly interfaces = new InterfaceTable();
  private readonly zones = new ZoneTable();
  private readonly objects = new ObjectStore();
  private readonly policy = new PolicyStore();
  private readonly natPolicy = new NatPolicyStore();
  private readonly pools = new IpPoolAllocator();
  private readonly policyRoutes = new PolicyRouteTable();
  private readonly proxyArp = new Map<string, readonly ProxyArpEntry[]>();
  private readonly nat: FirewallNatEngine;
  private readonly sessions: SessionTable;
  private readonly routes: RouteTable;
  private readonly arp: ArpService;
  private readonly evaluator: PolicyEvaluator;
  private readonly pipeline: FirewallPipeline;
  private readonly services: FirewallServices;
  protected readonly profile: FirewallProfile;
  private readonly logging = new LoggingConfig();
  private readonly syslog: SyslogAgent;
  private readonly boundPolicyInterfaces = new Set<string>();
  private readonly schedules = new ScheduleStore();
  private readonly allowedAccess = new Map<string, ReadonlySet<string>>();
  private sameSecurityInter = false;
  private sameSecurityIntra = false;
  private centralNat = false;

  constructor(
    deviceType: DeviceType, name: string, x = 0, y = 0, options: FirewallOptions = {},
  ) {
    super(deviceType, name, x, y);

    const profile = options.profile ?? GENERIC_PROFILE;
    this.profile = profile;

    const first = profile.portFirstIndex;
    for (let index = first; index < first + profile.portCount; index++) {
      const port = new Port(`${profile.portPrefix}${index}`, 'ethernet');
      this.addPort(port);
      this.interfaces.configure(port.getName(), { up: port.getIsUp() });
    }

    const now = options.now ?? (() => Date.now());
    this.syslog = new SyslogAgent(this, () => this.getBus());
    this.sessions = new SessionTable({ now });
    this.routes = new RouteTable({
      connectedRoutes: () => this.interfaces.connectedRoutes(),
      interfaceForDestination: (address) => this.interfaces.interfaceForDestination(address),
      isInterfaceUp: (iface) => this.interfaces.isUp(iface),
    });
    this.arp = new ArpService({
      interfaces: this.interfaces,
      macOf: (iface) => this.portMac(iface),
      now,
      onRequestNeeded: (request, iface) => this.emitArp(request, iface),
      proxyOwns: (address, iface) => this.proxyArpAnswers(address, iface),
    });
    this.evaluator = new PolicyEvaluator({
      objects: this.objects,
      policyKeyedBy: profile.policyKeyedBy,
      implicitPolicy: profile.implicitPolicy,
      applicationShift: profile.applicationShift,
      securityLevelOf: (zone) => this.zones.getZone(zone)?.securityLevel,
      interfaceHasBoundPolicy: (iface) => this.boundPolicyInterfaces.has(iface),
      scheduleActive: (name, at) => this.schedules.activeAt(name, at),
      sameSecurityInterAllowed: () => this.sameSecurityInter,
      now,
    });
    this.nat = new FirewallNatEngine({
      objects: this.objects,
      policy: this.natPolicy,
      pools: this.pools,
      interfaceAddress: (iface) => this.interfaces.get(iface)?.ip,
    });

    this.services = {
      zones: this.zones,
      interfaces: this.interfaces,
      routes: this.routes,
      objects: this.objects,
      policy: this.policy,
      evaluator: this.evaluator,
      sessions: this.sessions,
      natPolicy: this.natPolicy,
      nat: this.nat,
      policyRoutes: this.policyRoutes,
      centralNat: () => this.centralNat,
      policyKeyedBy: profile.policyKeyedBy,
      natOrder: {
        natIsPolicyField: profile.natIsPolicyField,
        policySeesPreNatSource: profile.natOrder.policySeesPreNatSource,
        policySeesPreNatDestination: profile.natOrder.policySeesPreNatDestination,
      },
      now,
    };

    const registry = new PipelineStageRegistry();
    for (const stage of createCoreStages(this.services)) registry.register(stage);
    this.pipeline = FirewallPipeline.fromStageNames(
      profile.pipeline, registry, `firewall.${this.id}`);
  }

  configureInterface(name: string, config: InterfaceConfig): void {
    this.interfaces.configure(name, config);

    const port = this.getPort(name);
    const iface = this.interfaces.get(name);
    if (port && iface?.ip && iface.mask) {
      port.configureIP(new IPAddress(iface.ip), new SubnetMask(iface.mask));
    }
  }

  simulate(request: SimulationRequest): SimulationResult {
    if (!this.getPort(request.ingressPort)) {
      throw new UnknownSimulationInterfaceError(request.ingressPort);
    }

    const context = makePacketContext({
      ingressPort: request.ingressPort,
      packet: buildSimulatedPacket(request),
      arrivedAt: this.services.now(),
      simulated: true,
    });

    const outcome = this.pipeline.process(context);
    return summariseSimulation(context, outcome.verdict === 'accepted');
  }

  setInterfaceUp(name: string, up: boolean): void {
    this.interfaces.setUp(name, up);
    this.getPort(name)?.setAdminShutdown(!up);
  }

  now(): number { return this.services.now(); }

  getLoggingConfig(): LoggingConfig { return this.logging; }

  getSyslogAgent(): SyslogAgent { return this.syslog; }

  syncSyslogAgent(): void {
    projectLoggingOntoSyslogAgent(this.logging, this.syslog);
  }

  logFirewallEvent(event: FirewallLogEvent, facts: FirewallLogFacts): void {
    const message = this.profile.syslogCatalog?.[event];
    if (!message) return;

    const text = firewallLogText(event, facts);
    this.logging.append(
      message.severity, this.profile.osName, text, false, message.id);
    this.syslog.sendImmediate(
      syslogSeverityOf(message.severity), this.profile.osName,
      `%${this.profile.osName.toUpperCase()}-${message.id}: ${text}`);
  }

  clearTranslations(): number {
    let cleared = 0;
    for (const session of this.sessions.view().all()) {
      if (session.translation === undefined) continue;
      this.nat.release(session.translation);
      this.sessions.close(session, 'clear');
      cleared++;
    }
    return cleared;
  }

  getScheduleStore(): ScheduleStore { return this.schedules; }

  setSchedule(schedule: ScheduleObject): boolean {
    return this.schedules.upsert(schedule);
  }

  setAllowedAccess(iface: string, services: readonly string[]): void {
    this.allowedAccess.set(iface, new Set(services.map(s => s.toLowerCase())));
  }

  allowsAccess(iface: string, service: string): boolean {
    const declared = this.allowedAccess.get(iface);
    if (declared === undefined) return true;
    return declared.has(service.toLowerCase());
  }

  allowedAccessOn(iface: string): readonly string[] {
    return [...(this.allowedAccess.get(iface) ?? [])];
  }

  getInterfaceTable(): InterfaceTable { return this.interfaces; }
  getZoneTable(): ZoneTable { return this.zones; }
  getObjectStore(): ObjectStore { return this.objects; }
  getPolicyStore(): PolicyStore { return this.policy; }
  getSessionTable(): SessionTable { return this.sessions; }
  getRouteTable(): RouteTable { return this.routes; }
  getArpService(): ArpService { return this.arp; }
  getNatPolicy(): NatPolicyStore { return this.natPolicy; }
  getNatEngine(): FirewallNatEngine { return this.nat; }
  getIpPools(): IpPoolAllocator { return this.pools; }
  getPolicyRoutes(): PolicyRouteTable { return this.policyRoutes; }
  getProfile(): FirewallProfile { return this.profile; }

  setCentralNat(enabled: boolean): void { this.centralNat = enabled; }
  centralNatEnabled(): boolean { return this.centralNat; }

  setIpPool(pool: IpPool): void {
    this.pools.upsert(pool);
    this.publishPoolProxyArp(pool);
  }

  removeIpPool(name: string): void {
    this.pools.remove(name);
    this.proxyArp.delete(proxyOwnerKey('ippool', name));
  }

  setProxyArpEntries(owner: string, entries: readonly ProxyArpEntry[]): void {
    if (entries.length === 0) { this.proxyArp.delete(owner); return; }
    this.proxyArp.set(owner, Object.freeze([...entries]));
  }

  clearProxyArpEntries(owner: string): void {
    this.proxyArp.delete(owner);
  }

  proxyArpAnswers(address: string, iface: string): boolean {
    const value = tryIpToUint32(address);
    if (value === null) return false;

    for (const entries of this.proxyArp.values()) {
      for (const entry of entries) {
        if (entry.iface !== undefined && entry.iface !== iface) continue;

        const from = tryIpToUint32(entry.from);
        const to = tryIpToUint32(entry.to ?? entry.from);
        if (from === null || to === null) continue;
        if (value >= from && value <= to) return true;
      }
    }
    return false;
  }

  proxyArpAddresses(): readonly ProxyArpEntry[] {
    const out: ProxyArpEntry[] = [];
    for (const entries of this.proxyArp.values()) out.push(...entries);
    return Object.freeze(out);
  }

  private publishPoolProxyArp(pool: IpPool): void {
    const owner = proxyOwnerKey('ippool', pool.name);
    if (!pool.arpReply) { this.proxyArp.delete(owner); return; }

    this.setProxyArpEntries(owner, [{
      from: pool.startIP,
      to: pool.endIP,
      iface: pool.arpInterface ?? pool.associatedInterface,
    }]);
  }

  bindPolicyToInterface(iface: string): void { this.boundPolicyInterfaces.add(iface); }
  unbindPolicyFromInterface(iface: string): void { this.boundPolicyInterfaces.delete(iface); }
  hasPolicyBound(iface: string): boolean { return this.boundPolicyInterfaces.has(iface); }

  setSameSecurityTraffic(kind: 'inter-interface' | 'intra-interface', enabled: boolean): void {
    if (kind === 'inter-interface') this.sameSecurityInter = enabled;
    else this.sameSecurityIntra = enabled;
  }

  sameSecurityTrafficEnabled(kind: 'inter-interface' | 'intra-interface'): boolean {
    return kind === 'inter-interface' ? this.sameSecurityInter : this.sameSecurityIntra;
  }
  getPipeline(): FirewallPipeline { return this.pipeline; }

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleArpFrame(portName, frame.payload as ARPPacket);
      return;
    }
    if (frame.etherType === ETHERTYPE_IPV4) {
      this.handleIpv4Frame(portName, frame.payload as IPv4Packet);
    }
  }

  private handleArpFrame(portName: string, packet: ARPPacket): void {
    if (!packet || packet.type !== 'arp') return;

    if (packet.operation === 'reply') {
      this.arp.handleReply(packet, portName);
      return;
    }

    const answer = this.arp.handleRequest(packet, portName);
    if (answer) this.emitArp(answer, portName);
  }

  private handleIpv4Frame(portName: string, packet: IPv4Packet): void {
    if (!packet || packet.type !== 'ipv4') return;

    const belongsToSession = this.sessions.lookup(flowKeyFromPacket(packet)) !== undefined;
    if (!belongsToSession
      && this.interfaces.owningInterface(packet.destinationIP.toString()) !== undefined
      && !this.destinationIsTranslated(portName, packet)) {
      this.deliverLocally(portName, packet);
      return;
    }

    const context = makePacketContext({
      ingressPort: portName, packet, arrivedAt: this.services.now(),
    });
    const outcome = this.pipeline.process(context);
    this.logPipelineOutcome(context, outcome.verdict === 'accepted');
    if (outcome.verdict !== 'accepted') return;

    const forwarded = outcome.payload ?? context;
    if (forwarded.egressPort === undefined) return;
    this.forward(
      forwarded.egressPort, forwarded.packet as IPv4Packet, forwarded.policyRouteGateway);
  }

  private logPipelineOutcome(context: PacketContext, accepted: boolean): void {
    const facts = logFactsOf(context, this.zones);

    if (!accepted) {
      this.logFirewallEvent('policy-deny', {
        ...facts, ruleId: context.matchedPolicy?.id, reason: context.verdict?.reason,
      });
      return;
    }
    if (context.session === undefined || !context.isFirstPacket) return;

    this.logFirewallEvent('session-built', { ...facts, sessionId: context.session.id });
    if (context.session.translation) {
      this.logFirewallEvent('translation-created', { ...facts, sessionId: context.session.id });
    }
  }

  private destinationIsTranslated(portName: string, packet: IPv4Packet): boolean {
    return this.nat.hasInboundRule(packet, {
      ingressZone: this.zones.zoneOf(portName) ?? portName,
      egressZone: '',
      ingressInterface: portName,
      egressInterface: '',
    });
  }

  private deliverLocally(portName: string, packet: IPv4Packet): void {
    if (packet.protocol !== IP_PROTO_ICMP) return;
    if (!this.allowsAccess(portName, 'ping')) return;

    const icmp = packet.payload as ICMPPacket | undefined;
    if (icmp?.type !== 'icmp' || icmp.icmpType !== 'echo-request') return;

    const reply: IPv4Packet = {
      ...packet,
      ttl: 64,
      headerChecksum: 0,
      sourceIP: packet.destinationIP,
      destinationIP: packet.sourceIP,
      payload: { ...icmp, icmpType: 'echo-reply' },
    };
    reply.headerChecksum = computeIPv4Checksum(reply);
    this.forward(portName, reply);
  }

  private forward(egressPort: string, packet: IPv4Packet, gateway?: string): void {
    const destination = packet.destinationIP.toString();
    const resolved = this.routes.resolveNextHop(destination);
    const nextHop = gateway ?? resolved?.nextHop ?? destination;

    const mac = this.resolveNextHopMac(nextHop, egressPort);
    if (!mac) return;

    this.sendFrame(egressPort, {
      srcMAC: this.portMac(egressPort),
      dstMAC: mac,
      etherType: ETHERTYPE_IPV4,
      payload: packet,
    });
  }

  private resolveNextHopMac(nextHop: string, egressPort: string): MACAddress | undefined {
    const known = this.arp.resolved(nextHop);
    if (known) return known;

    const request = this.arp.buildRequest(nextHop, egressPort);
    if (!request) return undefined;

    this.emitArp(request, egressPort);
    return this.arp.resolved(nextHop);
  }

  private emitArp(packet: ARPPacket, iface: string): void {
    this.sendFrame(iface, {
      srcMAC: this.portMac(iface),
      dstMAC: packet.operation === 'request' ? MACAddress.broadcast() : packet.targetMAC,
      etherType: ETHERTYPE_ARP,
      payload: packet,
    });
  }

  private portMac(iface: string) {
    return this.getPort(iface)!.getMAC();
  }
}

export function proxyOwnerKey(kind: string, name: string): string {
  return `${kind}:${name}`;
}

function logFactsOf(context: PacketContext, zones: ZoneTable): FirewallLogFacts {
  const packet = context.originalPacket as IPv4Packet;
  const payload = packet.payload as {
    type?: string; sourcePort?: number; destinationPort?: number;
  } | null;
  const ported = payload?.type === 'tcp' || payload?.type === 'udp';

  return {
    protocol: protocolLabel(packet.protocol),
    ingressZone: zones.zoneOf(context.ingressPort) ?? context.ingressPort,
    egressZone: context.egressPort === undefined
      ? (context.egressZone ?? 'any')
      : zones.zoneOf(context.egressPort) ?? context.egressPort,
    sourceIP: packet.sourceIP.toString(),
    sourcePort: ported ? payload?.sourcePort ?? 0 : 0,
    destinationIP: packet.destinationIP.toString(),
    destinationPort: ported ? payload?.destinationPort ?? 0 : 0,
  };
}

function protocolLabel(protocol: number): string {
  if (protocol === 6) return 'TCP';
  if (protocol === 17) return 'UDP';
  if (protocol === IP_PROTO_ICMP) return 'ICMP';
  return String(protocol);
}
