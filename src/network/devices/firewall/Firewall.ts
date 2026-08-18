import { Equipment } from '../../equipment/Equipment';
import { Port } from '../../hardware/Port';
import { Cable } from '../../hardware/Cable';
import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  IPAddress,
  MACAddress,
  SubnetMask,
  IP_PROTO_ESP,
  type ARPPacket,
  type DeviceType,
  type EthernetFrame,
  type IPv4Packet,
} from '../../core/types';
import { decryptFromTunnel, sealedLegs } from './vpn/IpsecDataPlane';
import { ikeDatagram, ipsecHostFacts } from './vpn/FirewallIpsecHost';
import { InterfaceTable, type InterfaceConfig } from './l3/InterfaceTable';
import { RouteTable } from './l3/RouteTable';
import {
  ProxyArpTable, proxyOwnerKey, type ProxyArpEntry,
} from './l3/ProxyArpTable';
import { ArpService } from './l3/ArpService';
import { ZoneTable } from './model/ZoneTable';
import { ObjectStore } from './model/ObjectStore';
import { PolicyStore } from './model/PolicyStore';
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
import { logFactsOf } from './logging/logFacts';
import { emitFirewallEvent } from './logging/emitFirewallEvent';
import {
  arpFrame, buildEgressFrame, icmpEchoReply,
  type BridgedFrame, type EgressDeps,
} from './l3/FirewallEgress';
import type { TcpStack } from '../../tcp/TcpStack';
import { buildFirewallAgents } from './FirewallAgents';
import { AccessMatrix } from './authz/AccessMatrix';
import {
  AuthPortal, buildAuthPortal, AUTH_PORTAL_PORT, AUTH_PORTAL_HTTPS_PORT,
  type RemoteAuthOutcome,
} from './auth/AuthPortal';
import {
  applyAdminAccount, adminTrustsSource, authenticateAdmin, remoteAuthenticate,
  type AdminAccountDraft,
} from './identity/AdminAccounts';
import type { RadiusClientAgent } from '../../radius/RadiusClientAgent';
import type { TacacsClientAgent } from '../../tacacs/TacacsClientAgent';
import type { IdentityTable } from './identity/IdentityTable';
import type { UserDirectory } from './identity/UserDirectory';
import type { IpsecTunnelTable } from './vpn/IpsecTunnelTable';
import type { CertificateStore } from './vpn/CertificateStore';
import type { IPSecEngine } from '../../ipsec/IPSecEngine';
import { bringUpTunnel, programIpsecEngine, udpDatagram } from './vpn/IpsecProgramming';
import { RouterHostsTable } from '../router/dns/RouterHostsTable';
import type { VdomServices } from './pipeline/stages/coreStages';
import { ScheduleStore, type ScheduleObject } from './model/ScheduleObject';
import { FirewallLogStore } from './logging/FirewallLogStore';
import { PacketCapture } from './diag/PacketCapture';
import type { UtmProfileStore } from './inspection/UtmProfiles';
import type { FirewallSession, SessionCloseReason } from './session/SessionTable';
import type { SecurityRule } from './model/SecurityRule';
import { LoggingConfig } from '../inspection/config/LoggingConfig';
import { SyslogAgent } from '../../syslog/SyslogAgent';
import {
  projectLoggingOntoSyslogAgent,
} from '../../syslog/loggingProjection';
import {
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

export class Firewall extends Equipment {
  private readonly interfaces = new InterfaceTable();
  private readonly vdoms: VdomRegistry;
  private readonly switchGroups = new Map<string, ReadonlySet<string>>();
  private readonly vdomLinks = new Map<string, readonly string[]>();
  private readonly macTable = new Map<string, string>();
  private readonly proxyArp = new ProxyArpTable();
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
  private readonly access = new AccessMatrix();
  protected readonly tcp: TcpStack;
  private readonly portal: AuthPortal;
  private readonly ipsec: IPSecEngine;
  private readonly hostsTable = new RouterHostsTable();
  private readonly radius: RadiusClientAgent;
  private readonly tacacs: TacacsClientAgent;
  private readonly adminSecrets = new Map<string, string>();
  private portalPorts = { http: AUTH_PORTAL_PORT, https: AUTH_PORTAL_HTTPS_PORT };
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
      deviceId: this.id,
      bus: () => this.getBus(),
      onTunnelInterface: (vdom, tunnel) => {
        this.interfaces.configure(tunnel, { up: true });
        this.assignInterfaceToVdom(tunnel, vdom);
      },
      onTunnelRemoved: (_vdom, tunnel) => { this.interfaces.remove(tunnel); },
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

    const agents = buildFirewallAgents({
      id: this.id,
      name: this.name,
      hostname: () => this.getHostname(),
      hostsTable: () => this.hostsTable,
      bus: () => this.getBus(),
      port: (n) => this.getPort(n),
      ports: () => this.getPorts(),
      send: (p, f) => { this.sendFrame(p, f); },
      resolveMac: (ip) => this.arp.resolved(ip) ?? null,
      sendArpAware: (p, packet, nextHop) =>
        this.sendIpv4FrameArpAware(p, packet, nextHop),
      sendUdp: (destIp, port, payload) => this.sendUdpToPeer(destIp, port, payload),
      ...ipsecHostFacts({
        interfaces: this.interfaces,
        routes: () => this.getVdom().routes,
        connected: (iface) => this.getPort(iface)?.isConnected(),
      }),
    });
    this.tcp = agents.tcp;
    this.ipsec = agents.ipsec;
    this.radius = agents.radius;
    this.tacacs = agents.tacacs;

    this.portal = buildAuthPortal({
      tcp: this.tcp,
      now,
      vdom: (name?: string) => this.getVdom(name),
      remoteAuthenticate: (server, user, password) =>
        this.remoteAuthenticate(server, user, password),
    });
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

  getTcpStack(): TcpStack { return this.tcp; }

  getAccessMatrix(): AccessMatrix { return this.access; }

  getAuthPortal(): AuthPortal { return this.portal; }

  getIpsecEngine(): IPSecEngine { return this.ipsec; }

  getCertificateStore(vdom?: string): CertificateStore {
    return this.getVdom(vdom).certificates;
  }

  syncIpsecTunnels(v?: string) {
    const vdom = this.getVdom(v);
    programIpsecEngine(this.ipsec, vdom.tunnels, vdom.certificates, this.services.now);
  }

  bringUpIpsecTunnel(name: string, v?: string): boolean {
    return bringUpTunnel(this.ipsec, this.getVdom(v).tunnels, name);
  }

  private sendUdpToPeer(destIp: string, port: number, payload: unknown): boolean {
    const route = this.getVdom().routes.resolveNextHop(destIp);
    const iface = route?.iface ?? this.interfaces.interfaceForDestination(destIp);
    const source = iface === undefined ? undefined : this.interfaces.get(iface)?.ip;
    if (iface === undefined || source === undefined) return false;

    this.forward(iface, udpDatagram(source, destIp, port, payload), route?.nextHop);
    return true;
  }

  sendIpv4FrameArpAware(
    iface: string, packet: IPv4Packet, nextHop: IPAddress,
  ): void {
    this.forward(iface, packet, nextHop.toString());
  }

  private remoteAuthenticate(
    server: string, user: string, password: string,
  ): Promise<RemoteAuthOutcome> {
    return remoteAuthenticate({
      tcp: this.tcp,
      server: (name) => this.getVdom().users.getServer(name),
      radius: this.radius,
      tacacs: this.tacacs,
    }, server, user, password);
  }

  setAuthPortalPorts(httpPort: number, httpsPort: number): void {
    this.portalPorts = { http: httpPort, https: httpsPort };
    if (!this.portal.isListening()) return;
    this.portal.stop();
    this.portal.start(httpPort);
  }

  getAuthPortalPorts(): { http: number; https: number } { return this.portalPorts; }

  startAuthPortal(): boolean { return this.portal.start(this.portalPorts.http); }

  applyAdminAccount(admin: AdminAccountDraft): void {
    applyAdminAccount(this.access, this.adminSecrets, admin);
  }

  authenticateAdmin(name: string, password: string, source?: string): boolean {
    return authenticateAdmin(this.access, this.adminSecrets, name, password, source);
  }

  adminTrustsSource(name: string, source: string): boolean {
    return adminTrustsSource(this.access, name, source);
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
    emitFirewallEvent({
      catalog: this.profile.syslogCatalog,
      osName: this.profile.osName,
      logging: this.logging,
      syslog: this.syslog,
    }, event, facts);
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

  createVdomLink(name: string): readonly string[] {
    const ends = [`${name}0`, `${name}1`];
    if (this.getPort(ends[0])) return Object.freeze(ends);

    const left = new Port(ends[0], 'ethernet');
    const right = new Port(ends[1], 'ethernet');
    this.addPort(left);
    this.addPort(right);
    for (const end of ends) this.interfaces.configure(end, { up: true });

    new Cable(`vdom-link:${this.id}:${name}`).connect(left, right);
    this.vdomLinks.set(name, Object.freeze(ends));
    return Object.freeze(ends);
  }

  removeVdomLink(name: string): boolean {
    const ends = this.vdomLinks.get(name);
    if (!ends) return false;

    for (const end of ends) {
      this.interfaces.remove(end);
      this.vdoms.releaseInterface(end);
    }
    return this.vdomLinks.delete(name);
  }

  vdomLinkEnds(name: string): readonly string[] {
    return this.vdomLinks.get(name) ?? [];
  }

  vdomLinkPeer(iface: string): string | undefined {
    for (const ends of this.vdomLinks.values()) {
      if (ends[0] === iface) return ends[1];
      if (ends[1] === iface) return ends[0];
    }
    return undefined;
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
  getUtmProfiles(vdom?: string): UtmProfileStore { return this.getVdom(vdom).utm; }
  getIdentityTable(vdom?: string): IdentityTable { return this.getVdom(vdom).identities; }
  getUserDirectory(vdom?: string): UserDirectory { return this.getVdom(vdom).users; }
  getTunnelTable(vdom?: string): IpsecTunnelTable { return this.getVdom(vdom).tunnels; }
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
    this.proxyArp.clear(proxyOwnerKey('ippool', name));
  }

  setProxyArpEntries(owner: string, entries: readonly ProxyArpEntry[]): void {
    this.proxyArp.set(owner, entries);
  }

  clearProxyArpEntries(owner: string): void {
    this.proxyArp.clear(owner);
  }

  proxyArpAnswers(address: string, iface: string): boolean {
    return this.proxyArp.answers(address, iface);
  }

  proxyArpAddresses(): readonly ProxyArpEntry[] {
    return this.proxyArp.all();
  }

  private publishPoolProxyArp(pool: IpPool): void {
    const owner = proxyOwnerKey('ippool', pool.name);
    if (!pool.arpReply) { this.proxyArp.clear(owner); return; }

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
    if (packet.operation === 'reply') { this.arp.handleReply(packet, portName); return; }

    const answer = this.arp.handleRequest(packet, portName);
    if (answer) this.emitArp(answer, portName);
  }

  private handleIpv4Frame(
    portName: string, packet: IPv4Packet, frame?: EthernetFrame,
  ): void {
    if (!packet || packet.type !== 'ipv4') return;

    if (packet.protocol === IP_PROTO_ESP
      && this.interfaces.owningInterface(packet.destinationIP.toString()) !== undefined) {
      const opened = decryptFromTunnel(this.ipsec, this.getVdom().tunnels, packet);
      if (opened) this.handleIpv4Frame(opened.tunnel, opened.inner);
      return;
    }

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
    const ike = ikeDatagram(packet);
    if (ike) { this.ipsec.handleIkeUdp(portName, packet, ike); return; }
    if (!this.allowsAccess(portName, 'ping')) return;

    const reply = icmpEchoReply(packet);
    if (reply) this.forward(portName, reply);
  }

  private forward(
    egressPort: string, packet: IPv4Packet, gateway?: string, bridged?: BridgedFrame,
  ): void {
    if (this.getVdom().tunnels.isTunnelInterface(egressPort)) {
      this.forwardThroughTunnel(egressPort, packet);
      return;
    }

    const frame = buildEgressFrame(this.egressDeps(), egressPort, packet, gateway, bridged);
    if (!frame) return;

    this.capture.record({
      at: this.services.now(), iface: egressPort, direction: 'out', frame,
    });
    this.sendFrame(egressPort, frame);
  }

  private forwardThroughTunnel(tunnelName: string, packet: IPv4Packet): void {
    const vdom = this.getVdom();
    for (const leg of sealedLegs(
      this.ipsec, vdom.tunnels, vdom.routes, tunnelName, packet)) {
      this.forward(leg.iface, leg.packet, leg.gateway);
    }
  }

  private emitArp(packet: ARPPacket, iface: string): void {
    this.sendFrame(iface, arpFrame(this.portMac(iface), packet));
  }

  private portMac(iface: string) {
    return this.getPort(iface)!.getMAC();
  }

  private egressDeps(): EgressDeps {
    return {
      nextHopFor: (iface, to) =>
        this.vdoms.contextOfInterface(iface).routes.resolveNextHop(to)?.nextHop,
      resolvedMac: (ip) => this.arp.resolved(ip),
      buildRequest: (ip, iface) => this.arp.buildRequest(ip, iface),
      emitArp: (request, iface) => this.emitArp(request, iface),
      portMac: (iface) => this.portMac(iface),
    };
  }
}

function vdomServices(context: VdomContext): VdomServices {
  return {
    ...context,
    centralNat: context.settings.centralNat,
    opmode: context.settings.opmode,
  };
}

export { proxyOwnerKey };
export type { ProxyArpEntry };
