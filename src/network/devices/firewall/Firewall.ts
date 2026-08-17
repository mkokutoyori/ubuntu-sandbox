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
import {
  GENERIC_PROFILE, type DeploymentMode, type FirewallProfile,
} from './FirewallProfile';
import { ROOT_VDOM, VdomRegistry, type VdomContext } from './vdom/VdomRegistry';
import type { VdomServices } from './pipeline/stages/coreStages';
import { ScheduleStore, type ScheduleObject } from './model/ScheduleObject';
import { FirewallLogStore } from './logging/FirewallLogStore';
import { PacketCapture } from './diag/PacketCapture';
import type { FirewallSession, SessionCloseReason } from './session/SessionTable';
import type { SecurityRule } from './model/SecurityRule';
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

const TRACE_HISTORY = 32;

export interface TrafficLogger {
  onSessionOpened(session: FirewallSession, rule?: SecurityRule): void;
  onSessionClosed(session: FirewallSession, reason: SessionCloseReason): void;
  onDenied(context: PacketContext): void;
}

export interface BridgedFrame {
  readonly srcMAC: MACAddress;
  readonly dstMAC: MACAddress;
}

export interface ProxyArpEntry {
  readonly from: string;
  readonly to?: string;
  readonly iface?: string;
}

export class Firewall extends Equipment {
  private readonly interfaces = new InterfaceTable();
  private readonly vdoms: VdomRegistry;
  private readonly switchGroups = new Map<string, ReadonlySet<string>>();
  private readonly macTable = new Map<string, string>();
  private readonly proxyArp = new Map<string, readonly ProxyArpEntry[]>();
  private readonly arp: ArpService;
  private readonly registry = new PipelineStageRegistry();
  private readonly pipelines = new Map<string, FirewallPipeline>();
  private readonly services: FirewallServices;
  protected readonly profile: FirewallProfile;
  private readonly logging = new LoggingConfig();
  private readonly syslog: SyslogAgent;
  private readonly boundPolicyInterfaces = new Set<string>();
  private readonly allowedAccess = new Map<string, ReadonlySet<string>>();
  private readonly capture = new PacketCapture();
  private readonly traces: PacketContext[] = [];
  private sessionObserver?: (session: FirewallSession, reason: SessionCloseReason) => void;
  private trafficLogger?: TrafficLogger;
  private sameSecurityInter = false;
  private sameSecurityIntra = false;
  private multiVdom = false;
  private activeVdom = ROOT_VDOM;

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
    this.vdoms = new VdomRegistry({
      now,
      policyKeyedBy: profile.policyKeyedBy,
      implicitPolicy: profile.implicitPolicy,
      applicationShift: profile.applicationShift,
      maxGroupNesting: profile.maxGroupNesting,
      connectedRoutes: (vdom) => this.interfaces.connectedRoutes()
        .filter(route => this.vdoms.vdomOfInterface(route.iface) === vdom),
      interfaceForDestination: (vdom, address) => {
        const iface = this.interfaces.interfaceForDestination(address);
        return iface !== undefined && this.vdoms.vdomOfInterface(iface) === vdom
          ? iface
          : undefined;
      },
      isInterfaceUp: (iface) => this.interfaces.isUp(iface),
      interfaceAddress: (iface) => this.interfaces.get(iface)?.ip,
      interfaceHasBoundPolicy: (iface) => this.boundPolicyInterfaces.has(iface),
      securityLevelOf: (vdom, zone) => this.vdoms.require(vdom).zones.getZone(zone)?.securityLevel,
      sameSecurityInterAllowed: () => this.sameSecurityInter,
      onSessionClosed: (_vdom, session, reason) => {
        this.trafficLogger?.onSessionClosed(session, reason);
        this.sessionObserver?.(session, reason);
      },
    });
    this.arp = new ArpService({
      interfaces: this.interfaces,
      macOf: (iface) => this.portMac(iface),
      now,
      onRequestNeeded: (request, iface) => this.emitArp(request, iface),
      proxyOwns: (address, iface) => this.proxyArpAnswers(address, iface),
    });

    this.services = {
      interfaces: this.interfaces,
      vdomOf: (iface) => vdomServices(this.vdoms.contextOfInterface(iface)),
      policyKeyedBy: profile.policyKeyedBy,
      bridgedWith: (ingress, egress) => this.sameSwitchInterface(ingress, egress),
      macLookup: (destination, ingress) => this.lookupMac(destination, ingress),
      natOrder: {
        natIsPolicyField: profile.natIsPolicyField,
        policySeesPreNatSource: profile.natOrder.policySeesPreNatSource,
        policySeesPreNatDestination: profile.natOrder.policySeesPreNatDestination,
      },
      now,
    };

    for (const stage of createCoreStages(this.services)) this.registry.register(stage);
  }

  private pipelineFor(mode: DeploymentMode): FirewallPipeline {
    const cached = this.pipelines.get(mode);
    if (cached) return cached;

    const built = FirewallPipeline.fromStageNames(
      this.profile.pipeline[mode], this.registry, `firewall.${this.id}.${mode}`);
    this.pipelines.set(mode, built);
    return built;
  }

  private processPipeline(context: PacketContext) {
    const vdom = this.vdoms.contextOfInterface(context.ingressPort);
    return this.pipelineFor(vdom.settings.opmode).process(context);
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

    const outcome = this.processPipeline(context);
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
    for (const vdom of this.vdoms.all()) {
      for (const session of vdom.sessions.view().all()) {
        if (session.translation === undefined) continue;
        vdom.nat.release(session.translation);
        vdom.sessions.close(session, 'clear');
        cleared++;
      }
    }
    return cleared;
  }

  setSchedule(schedule: ScheduleObject, vdom?: string): boolean {
    return this.getVdom(vdom).schedules.upsert(schedule);
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

  getVdomRegistry(): VdomRegistry { return this.vdoms; }

  getVdom(name?: string): VdomContext {
    return this.vdoms.require(name ?? this.activeVdom);
  }

  setActiveVdom(name: string): void {
    this.vdoms.require(name);
    this.activeVdom = name;
  }

  activeVdomName(): string { return this.activeVdom; }

  setMultiVdom(enabled: boolean): void { this.multiVdom = enabled; }
  multiVdomEnabled(): boolean { return this.multiVdom; }

  assignInterfaceToVdom(iface: string, vdom: string): void {
    this.vdoms.assignInterface(iface, vdom);
  }

  vdomOfInterface(iface: string): string {
    return this.vdoms.vdomOfInterface(iface);
  }

  setSwitchInterface(name: string, members: readonly string[]): void {
    this.switchGroups.set(name, new Set(members));
  }

  removeSwitchInterface(name: string): boolean {
    return this.switchGroups.delete(name);
  }

  switchInterfaces(): readonly string[] {
    return Object.freeze([...this.switchGroups.keys()]);
  }

  switchMembers(name: string): readonly string[] {
    return Object.freeze([...(this.switchGroups.get(name) ?? [])]);
  }

  sameSwitchInterface(left: string, right: string): boolean {
    for (const members of this.switchGroups.values()) {
      if (members.has(left) && members.has(right)) return true;
    }
    return false;
  }

  setOperationMode(mode: DeploymentMode, vdom?: string): void {
    this.getVdom(vdom).settings.opmode = mode;
  }

  operationMode(vdom?: string): DeploymentMode {
    return this.getVdom(vdom).settings.opmode;
  }

  setManagementAddress(ip: string, mask: string, gateway?: string, vdom?: string): void {
    const settings = this.getVdom(vdom).settings;
    settings.manageIP = ip;
    settings.manageMask = mask;
    settings.gateway = gateway;
  }

  managementAddress(vdom?: string): string | undefined {
    return this.getVdom(vdom).settings.manageIP;
  }

  getInterfaceTable(): InterfaceTable { return this.interfaces; }
  getZoneTable(vdom?: string): ZoneTable { return this.getVdom(vdom).zones; }
  getObjectStore(vdom?: string): ObjectStore { return this.getVdom(vdom).objects; }
  getPolicyStore(vdom?: string): PolicyStore { return this.getVdom(vdom).policy; }
  getSessionTable(vdom?: string): SessionTable { return this.getVdom(vdom).sessions; }
  getRouteTable(vdom?: string): RouteTable { return this.getVdom(vdom).routes; }
  getArpService(): ArpService { return this.arp; }
  getNatPolicy(vdom?: string): NatPolicyStore { return this.getVdom(vdom).natPolicy; }
  getNatEngine(vdom?: string): FirewallNatEngine { return this.getVdom(vdom).nat; }
  getIpPools(vdom?: string): IpPoolAllocator { return this.getVdom(vdom).pools; }
  getPolicyRoutes(vdom?: string): PolicyRouteTable { return this.getVdom(vdom).policyRoutes; }
  getScheduleStore(vdom?: string): ScheduleStore { return this.getVdom(vdom).schedules; }
  getLogStore(vdom?: string): FirewallLogStore { return this.getVdom(vdom).logs; }
  getProfile(): FirewallProfile { return this.profile; }

  setCentralNat(enabled: boolean, vdom?: string): void {
    this.getVdom(vdom).settings.centralNat = enabled;
  }

  centralNatEnabled(vdom?: string): boolean {
    return this.getVdom(vdom).settings.centralNat;
  }

  setIpPool(pool: IpPool, vdom?: string): void {
    this.getVdom(vdom).pools.upsert(pool);
    this.publishPoolProxyArp(pool);
  }

  removeIpPool(name: string, vdom?: string): void {
    this.getVdom(vdom).pools.remove(name);
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
  getPipeline(mode: DeploymentMode = 'nat'): FirewallPipeline {
    return this.pipelineFor(mode);
  }

  getPacketCapture(): PacketCapture { return this.capture; }

  onSessionClosed(
    observer: (session: FirewallSession, reason: SessionCloseReason) => void,
  ): void {
    this.sessionObserver = observer;
  }

  setTrafficLogger(logger: TrafficLogger): void {
    this.trafficLogger = logger;
  }

  recentTraces(limit = TRACE_HISTORY): readonly PacketContext[] {
    return Object.freeze(this.traces.slice(-Math.max(1, limit)));
  }

  clearTraces(): void {
    this.traces.length = 0;
  }

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    this.capture.record({
      at: this.services.now(), iface: portName, direction: 'in', frame,
    });
    this.macTable.set(frame.srcMAC.toString(), portName);

    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleArpFrame(portName, frame.payload as ARPPacket);
      return;
    }
    if (frame.etherType === ETHERTYPE_IPV4) {
      this.handleIpv4Frame(portName, frame.payload as IPv4Packet, frame);
    }
  }

  private lookupMac(destination: MACAddress, ingress: string): string | undefined {
    const learned = this.macTable.get(destination.toString());
    return learned === undefined || learned === ingress ? undefined : learned;
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

  private handleIpv4Frame(
    portName: string, packet: IPv4Packet, frame?: EthernetFrame,
  ): void {
    if (!packet || packet.type !== 'ipv4') return;

    const vdom = this.vdoms.contextOfInterface(portName);
    const belongsToSession = vdom.sessions.lookup(flowKeyFromPacket(packet)) !== undefined;
    if (!belongsToSession && this.destinedToSelf(portName, vdom, packet)
      && !this.destinationIsTranslated(portName, packet)) {
      this.deliverLocally(portName, packet);
      return;
    }

    const context = makePacketContext({
      ingressPort: portName,
      packet,
      arrivedAt: this.services.now(),
      ingressFrameDestination: frame?.dstMAC,
    });
    const outcome = this.processPipeline(context);
    this.rememberTrace(context);
    this.logPipelineOutcome(context, outcome.verdict === 'accepted');
    if (outcome.verdict !== 'accepted') return;

    const forwarded = outcome.payload ?? context;
    if (forwarded.egressPort === undefined) return;

    const bridged = frame !== undefined
      && (forwarded.bridged === true || vdom.settings.opmode === 'transparent')
      ? { srcMAC: frame.srcMAC, dstMAC: frame.dstMAC }
      : undefined;
    this.forward(forwarded.egressPort, forwarded.packet as IPv4Packet,
      forwarded.policyRouteGateway, bridged);
  }

  private rememberTrace(context: PacketContext): void {
    this.traces.push(context);
    while (this.traces.length > TRACE_HISTORY) this.traces.shift();
  }

  private destinedToSelf(
    portName: string, vdom: VdomContext, packet: IPv4Packet,
  ): boolean {
    const destination = packet.destinationIP.toString();
    if (vdom.settings.opmode === 'transparent') {
      return vdom.settings.manageIP === destination;
    }
    return this.interfaces.owningInterface(destination) !== undefined;
  }

  private logPipelineOutcome(context: PacketContext, accepted: boolean): void {
    const facts = logFactsOf(context, this.vdoms.contextOfInterface(context.ingressPort).zones);

    if (!accepted) {
      this.logFirewallEvent('policy-deny', {
        ...facts, ruleId: context.matchedPolicy?.id, reason: context.verdict?.reason,
      });
      this.trafficLogger?.onDenied(context);
      return;
    }
    if (context.session === undefined || !context.isFirstPacket) return;

    this.trafficLogger?.onSessionOpened(context.session, context.matchedPolicy);
    this.logFirewallEvent('session-built', { ...facts, sessionId: context.session.id });
    if (context.session.translation) {
      this.logFirewallEvent('translation-created', { ...facts, sessionId: context.session.id });
    }
  }

  private destinationIsTranslated(portName: string, packet: IPv4Packet): boolean {
    const vdom = this.vdoms.contextOfInterface(portName);
    return vdom.nat.hasInboundRule(packet, {
      ingressZone: vdom.zones.zoneOf(portName) ?? portName,
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

  private forward(
    egressPort: string, packet: IPv4Packet, gateway?: string, bridged?: BridgedFrame,
  ): void {
    const destination = packet.destinationIP.toString();
    const vdom = this.vdoms.contextOfInterface(egressPort);
    const resolved = vdom.routes.resolveNextHop(destination);
    const nextHop = gateway ?? resolved?.nextHop ?? destination;

    const mac = bridged?.dstMAC ?? this.resolveNextHopMac(nextHop, egressPort);
    if (!mac) return;

    const frame: EthernetFrame = {
      srcMAC: bridged?.srcMAC ?? this.portMac(egressPort),
      dstMAC: mac,
      etherType: ETHERTYPE_IPV4,
      payload: packet,
    };
    this.capture.record({
      at: this.services.now(), iface: egressPort, direction: 'out', frame,
    });
    this.sendFrame(egressPort, frame);
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

function vdomServices(context: VdomContext): VdomServices {
  return {
    name: context.name,
    zones: context.zones,
    routes: context.routes,
    objects: context.objects,
    policy: context.policy,
    evaluator: context.evaluator,
    sessions: context.sessions,
    natPolicy: context.natPolicy,
    nat: context.nat,
    policyRoutes: context.policyRoutes,
    centralNat: context.settings.centralNat,
    opmode: context.settings.opmode,
  };
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
