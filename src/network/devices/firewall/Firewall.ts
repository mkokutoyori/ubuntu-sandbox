import { Equipment } from '../../equipment/Equipment';
import { Port } from '../../hardware/Port';
import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  IPAddress,
  MACAddress,
  SubnetMask,
  type ARPPacket,
  type DeviceType,
  type EthernetFrame,
  type IPv4Packet,
} from '../../core/types';
import { SystemClock } from '../../core/SystemClock';
import { localTimeMs, utcMsForLocal } from '../../core/Timezone';
import { decryptFromTunnel, sealedLegs } from './vpn/IpsecDataPlane';
import { ikeDatagram, ipsecHostFacts } from './vpn/FirewallIpsecHost';
import { InterfaceTable, type InterfaceConfig } from './l3/InterfaceTable';
import { RouteTable } from './l3/RouteTable';
import {
  ProxyArpTable, proxyOwnerKey, publishPoolProxyArp, type ProxyArpEntry,
} from './l3/ProxyArpTable';
import { ArpService } from './l3/ArpService';
import { ZoneTable } from './model/ZoneTable';
import { ObjectStore } from './model/ObjectStore';
import { PolicyStore } from './model/PolicyStore';
import { SessionTable } from './session/SessionTable';
import { NatPolicyStore } from './nat/NatPolicyStore';
import { FirewallNatEngine, clearVdomTranslations } from './nat/FirewallNatEngine';
import { IpPoolAllocator, type IpPool } from './nat/IpPool';
import { PolicyRouteTable } from './l3/PolicyRouteTable';
import { FirewallPipeline, PipelineStageRegistry } from './pipeline/FirewallPipeline';
import { PipelineCache } from './pipeline/PipelineCache';
import { makePacketContext, type PacketContext } from './pipeline/PacketContext';
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
import { VdomLinkTable } from './vdom/VdomLinkTable';
import { SwitchGroupTable } from './l3/SwitchGroupTable';
import { logFactsOf } from './logging/logFacts';
import { emitFirewallEvent, logPipelineOutcome } from './logging/emitFirewallEvent';
import {
  arpFrame, buildEgressFrame, egressDepsOf, type BridgedFrame, type EgressDeps,
} from './l3/FirewallEgress';
import { deliverLocally } from './l3/LocalDelivery';
import type { FirewallDhcp } from './l3/FirewallDhcp';
import type { TcpStack } from '../../tcp/TcpStack';
import { buildFirewallAgents } from './FirewallAgents';
import { AccessMatrix } from './authz/AccessMatrix';
import { AuthPortal, type RemoteAuthOutcome } from './auth/AuthPortal';
import type { FirewallPortals, PortalPorts } from './auth/FirewallPortals';
import { remoteAuthenticate, type AdminAccountDraft } from './identity/AdminAccounts';
import type { RadiusClientAgent } from '../../radius/RadiusClientAgent';
import type { TacacsClientAgent } from '../../tacacs/TacacsClientAgent';
import type { IdentityTable } from './identity/IdentityTable';
import type { UserDirectory } from './identity/UserDirectory';
import type { IpsecTunnelTable } from './vpn/IpsecTunnelTable';
import type { CertificateStore } from './vpn/CertificateStore';
import type { FirewallRouting } from './routing/FirewallRouting';
import { buildL3Services, type L3Services } from './l3/L3ServiceWiring';
import { classifyIpv4, ingressHostOf, type Ipv4IngressHost } from './l3/Ipv4Ingress';
import type { FirewallNtp } from './mgmt/FirewallNtp';
import { buildManagementServices } from './mgmt/ManagementWiring';
import type { ManagementCli } from './mgmt/FirewallCliServer';
import { ManagementPlane } from './mgmt/ManagementPlane';
import type { ManagementPorts } from './mgmt/ManagementAccess';
import type { CaptivePortalRedirect } from './auth/CaptivePortalRedirect';
import type { NtpAgent } from '../../ntp/NtpAgent';
import { FirewallPing } from './diag/FirewallPing';
import { FirewallTraceroute } from './diag/FirewallTraceroute';
import {
  FirewallDnsClient, dnsQueryDatagram,
} from './l3/FirewallDnsClient';
import type { SdwanService } from './sdwan/SdwanService';
import { ETHERTYPE_FGCP, type HaAgent } from './ha/HaAgent';
import { serialNumberOf, type FirewallHa } from './ha/FirewallHa';
import type { HaConfiguration } from './ha/HaTypes';
import type { SdwanConfiguration } from './sdwan/SdwanTable';
import type { SslVpnPortal, SslVpnSettings } from './vpn/SslVpnPortal';
import type { IPSecEngine } from '../../ipsec/IPSecEngine';
import { bringUpTunnel, programIpsecEngine, udpDatagram } from './vpn/IpsecProgramming';
import { RouterHostsTable } from '../router/dns/RouterHostsTable';
import type { VdomServices } from './pipeline/stages/coreStages';
import { ScheduleStore, type ScheduleObject } from './model/ScheduleObject';
import { FirewallLogStore } from './logging/FirewallLogStore';
import { PacketCapture } from './diag/PacketCapture';
import { TraceRing, TRACE_HISTORY } from './diag/TraceRing';
import type { UtmProfileStore } from './inspection/UtmProfiles';
import type { FirewallSession, SessionCloseReason } from './session/SessionTable';
import type { SecurityRule } from './model/SecurityRule';
import { LoggingConfig } from '../inspection/config/LoggingConfig';
import { SyslogAgent } from '../../syslog/SyslogAgent';
import { SyslogCollectorTable } from './logging/SyslogCollectors';
import { projectLoggingOntoSyslogAgent } from '../../syslog/loggingProjection';
import {
  type FirewallLogEvent,
  type FirewallLogFacts,
} from './logging/SyslogCatalog';

export interface FirewallOptions {
  profile?: FirewallProfile;
  now?: () => number;
}

export interface TrafficLogger {
  onSessionOpened(session: FirewallSession, rule?: SecurityRule): void;
  onSessionClosed(session: FirewallSession, reason: SessionCloseReason): void;
  onDenied(context: PacketContext): void;
}

export class Firewall extends Equipment {
  private readonly interfaces = new InterfaceTable();
  private readonly vdoms: VdomRegistry;
  private readonly switchGroups = new SwitchGroupTable();
  private readonly vdomLinks: VdomLinkTable;
  private readonly macTable = new Map<string, string>();
  private readonly proxyArp = new ProxyArpTable();
  private readonly arp: ArpService;
  private readonly registry = new PipelineStageRegistry();
  private readonly pipelines: PipelineCache;
  private readonly services: FirewallServices;
  protected readonly profile: FirewallProfile;
  private readonly logging = new LoggingConfig();
  private readonly clock: SystemClock;
  private readonly syslog: SyslogAgent;
  private readonly syslogCollectors: SyslogCollectorTable;
  private readonly boundPolicyInterfaces = new Set<string>();
  private readonly capture = new PacketCapture();
  private readonly access = new AccessMatrix();
  protected readonly tcp: TcpStack;
  private readonly portal: AuthPortal;
  private readonly sslVpn: SslVpnPortal;
  private readonly portals: FirewallPortals;
  private readonly sdwan: SdwanService;
  private readonly routing: FirewallRouting;
  private readonly dhcp: FirewallDhcp;
  private readonly l3: L3Services;
  private readonly ntp: FirewallNtp;
  private readonly captivePortal: CaptivePortalRedirect;
  private readonly management: ManagementPlane;

  private readonly haService: FirewallHa;
  private readonly ipsec: IPSecEngine;
  private readonly hostsTable = new RouterHostsTable();
  private readonly radius: RadiusClientAgent;
  private readonly tacacs: TacacsClientAgent;
  private readonly traces = new TraceRing();
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
    this.pipelines = new PipelineCache(this.id, profile, this.registry);

    const first = profile.portFirstIndex;
    for (let index = first; index < first + profile.portCount; index++) {
      const port = new Port(`${profile.portPrefix}${index}`, 'ethernet');
      this.addPort(port);
      this.interfaces.configure(port.getName(), { up: port.getIsUp() });
    }

    this.vdomLinks = new VdomLinkTable({
      deviceId: this.id,
      port: (name) => this.getPort(name),
      addPort: (port) => { this.addPort(port); },
      declareInterface: (name) => { this.interfaces.configure(name, { up: true }); },
      forgetInterface: (name) => {
        this.interfaces.remove(name);
        this.vdoms.releaseInterface(name);
      },
    });

    this.clock = new SystemClock(options.now ?? (() => Date.now()));
    const now = () => this.clock.now();
    this.syslog = new SyslogAgent(this, () => this.getBus());
    this.syslogCollectors = new SyslogCollectorTable(() => this.syslog);
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
      resolveFqdn: (fqdn) => this.dnsClient.resolve(fqdn),
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

    this.management = new ManagementPlane(this.access, now);

    const mgmt = buildManagementServices({
      deviceId: this.id, deviceName: name, hostname: () => this.getName(),
      bus: () => this.getBus(), now, tcp: () => this.tcp,
      vdom: (v?: string) => this.getVdom(v),
      certificates: () => this.getCertificateStore(),
      remoteAuthenticate: (s1, u, p) => this.remoteAuthenticate(s1, u, p),
      serial: () => this.serialNumber(),
      port: (iface) => this.getPort(iface),
      ports: () => [...this.getPorts().values()],
      sendFrame: (iface, frame) => { this.sendFrame(iface, frame); },
      sessions: () => this.getVdom().sessions,
      connectedRoutes: () => this.interfaces.connectedRoutes(),
      addressOf: (iface) => this.interfaces.get(iface)?.ip,
      authenticated: (iface, address) =>
        this.vdoms.contextOfInterface(iface).identities.lookup(address) !== undefined,
      authRequiredByPolicy: () => this.getVdom().policy.ordered()
        .some(r => (r.authUsers?.length ?? 0) > 0 || (r.authGroups?.length ?? 0) > 0),
      managementPorts: () => this.management.managementPorts(),
      createManagementCli: (user) => this.createManagementCli(user),
      authenticateAdmin: (user, password, source) =>
        this.management.login(user, password, source),
      knownAdmin: (user) => this.access.getAdmin(user) !== undefined,
      refuseManagementSource: (source) => this.management.refusesSource(source),
      managementIdleTimeoutMs: () => this.management.idleTimeoutMs(),
      runningConfig: () => this.managementRunningConfig(),
      onManagementLogin: (_user, source) => { this.management.noteLogin(source); },
      onManagementAuthFailure: (_user, source) => {
        this.management.noteAuthFailure(source);
      },
    });
    this.portals = mgmt.portals;
    this.portal = mgmt.portals.auth;
    this.sslVpn = mgmt.portals.sslVpn;
    this.haService = mgmt.ha;
    this.ntp = mgmt.ntp;
    this.captivePortal = mgmt.captivePortal;
    this.management.attachCliServer(mgmt.cli);

    const l3 = buildL3Services({
      deviceId: this.id,
      hostname: () => this.getName(),
      bus: () => this.getBus(),
      tcp: () => this.tcp,
      routes: () => this.getVdom().routes,
      interfaces: () => this.interfaces,
      port: (iface) => this.getPort(iface),
      resolvedMac: (ip) => this.arp.resolved(ip) ?? undefined,
      emitFrame: (iface, frame) => {
        this.capture.record({ at: this.services.now(), iface, direction: 'out', frame });
        this.sendFrame(iface, frame);
      },
      assignAddress: (iface, ip, mask) => { this.configureInterface(iface, { ip, mask }); },
      forward: (iface, packet, gateway) => { this.forward(iface, packet, gateway); },
    });

    this.l3 = l3;
    this.routing = l3.routing;
    this.dhcp = l3.dhcp;
    this.sdwan = l3.sdwan;

  }

  private processPipeline(context: PacketContext) {
    const vdom = this.vdoms.contextOfInterface(context.ingressPort);
    return this.pipelines.forMode(vdom.settings.opmode).process(context);
  }

  getTcpStack(): TcpStack { return this.tcp; }
  getAccessMatrix(): AccessMatrix { return this.access; }
  getAuthPortal(): AuthPortal { return this.portal; }
  getIpsecEngine(): IPSecEngine { return this.ipsec; }
  getCertificateStore(v?: string): CertificateStore { return this.getVdom(v).certificates; }
  getSslVpnPortal(): SslVpnPortal { return this.sslVpn; }
  getSdwan(): SdwanService { return this.sdwan; }

  private readonly ping = new FirewallPing({
    resolve: (destination) => {
      const route = this.getVdom().routes.resolveNextHop(destination);
      const iface = route?.iface ?? this.interfaces.interfaceForDestination(destination);
      if (iface === undefined) return null;
      const source = this.interfaces.get(iface)?.ip;
      if (source === undefined) return null;
      return { iface, gateway: route?.nextHop, source };
    },
    send: (iface, packet, gateway) => { this.forward(iface, packet, gateway); },
    onReply: (payload) => {
      this.getBus().publish({
        topic: 'host.icmp.echo-reply',
        payload: { deviceId: this.id, hostname: this.getHostname(), rttMs: 0, ...payload },
      });
    },
  });

  runPing(target: string, count?: number): string { return this.ping.run(target, count); }

  private readonly traceroute = new FirewallTraceroute({
    resolve: (destination) => {
      const route = this.getVdom().routes.resolveNextHop(destination);
      const iface = route?.iface ?? this.interfaces.interfaceForDestination(destination);
      if (iface === undefined) return null;
      const source = this.interfaces.get(iface)?.ip;
      if (source === undefined) return null;
      return { iface, gateway: route?.nextHop, source };
    },
    send: (iface, packet, gateway) => { this.forward(iface, packet, gateway); },
  });

  runTraceroute(target: string): string { return this.traceroute.run(target); }

  private readonly dnsClient = new FirewallDnsClient({
    send: (destination, sourcePort, payload) => {
      const route = this.getVdom().routes.resolveNextHop(destination);
      const iface = route?.iface ?? this.interfaces.interfaceForDestination(destination);
      const source = iface === undefined ? undefined : this.interfaces.get(iface)?.ip;
      if (iface === undefined || source === undefined) return false;
      this.forward(iface,
        dnsQueryDatagram(source, destination, sourcePort, payload), route?.nextHop);
      return true;
    },
  });

  getDnsClient(): FirewallDnsClient { return this.dnsClient; }

  listL3Interfaces(): readonly import('./l3/InterfaceTable').L3Interface[] {
    return this.interfaces.all();
  }

  interfaceIndex(name: string): number {
    return this.interfaces.names().indexOf(name) + 1;
  }
  getRouting(): FirewallRouting { return this.routing; }
  getDhcp(): FirewallDhcp { return this.dhcp; }
  getNtp(): FirewallNtp { return this.ntp; }
  getNtpAgent(): NtpAgent { return this.ntp.getAgent(); }
  getCaptivePortal(): CaptivePortalRedirect { return this.captivePortal; }

  setCaptivePortalInterface(iface: string, on: boolean): void {
    this.captivePortal.setInterfaceMode(iface, on);
  }

  refreshCaptivePortal(): void {
    this.captivePortal.refresh();
    if (this.captivePortal.isArmed()) this.portals.startAuth();
  }

  getHa(): HaAgent { return this.haService.agent; }

  applyHa(c: HaConfiguration): string | undefined {
    this.haService.agent.configure(c);
    return undefined;
  }

  serialNumber(): string { return serialNumberOf(this.name); }
  applySdwan(c: SdwanConfiguration): string | undefined { return this.sdwan.apply(c); }
  runSdwanHealthChecks(): Promise<void> { return this.sdwan.runHealthChecks(); }

  bindHaConfiguration(read: () => string, apply: (text: string) => void): void {
    this.haService.bindConfiguration(read, apply);
  }

  applySslVpnSettings(s: SslVpnSettings): string | undefined { return this.sslVpn.apply(s); }

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
      server: (n) => this.getVdom().users.getServer(n),
      radius: this.radius,
      tacacs: this.tacacs,
    }, server, user, password);
  }

  setAuthPortalPorts(httpPort: number, httpsPort: number): void {
    this.portals.setPorts(httpPort, httpsPort);
  }

  getAuthPortalPorts(): PortalPorts { return this.portals.ports(); }
  startAuthPortal(): boolean { return this.portals.startAuth(); }

  applyAdminAccount(admin: AdminAccountDraft): void { this.management.applyAdmin(admin); }

  authenticateAdmin(name: string, password: string, source?: string): boolean {
    return this.management.authenticate(name, password, source);
  }

  adminTrustsSource(name: string, source: string): boolean {
    return this.management.trustsSource(name, source);
  }

  configureInterface(name: string, config: InterfaceConfig): void {
    this.interfaces.configure(name, config);

    const port = this.getPort(name);
    const iface = this.interfaces.get(name);
    if (port && iface?.ip && iface.mask) {
      port.configureIP(new IPAddress(iface.ip), new SubnetMask(iface.mask));
    }
    this.routing.refreshInterfaces();
  }

  simulate(request: SimulationRequest): SimulationResult {
    if (!this.getPort(request.ingressPort)) {
      throw new UnknownSimulationInterfaceError(request.ingressPort);
    }
    const context = makePacketContext({
      ingressPort: request.ingressPort, packet: buildSimulatedPacket(request),
      arrivedAt: this.services.now(), simulated: true,
    });
    return summariseSimulation(
      context, this.processPipeline(context).verdict === 'accepted');
  }

  setInterfaceUp(name: string, up: boolean): void {
    this.interfaces.setUp(name, up);
    this.getPort(name)?.setAdminShutdown(!up);
  }

  now(): number { return this.services.now(); }

  getSystemClock(): SystemClock { return this.clock; }

  private timezoneName = 'Europe/Paris';

  setTimezone(name: string): void { this.timezoneName = name; }

  getTimezone(): string { return this.timezoneName; }

  localNow(): number { return localTimeMs(this.timezoneName, this.now()); }

  setLocalClock(localMs: number): void {
    this.clock.set(utcMsForLocal(this.timezoneName, localMs));
  }

  managementIdleTimeoutMs(): number { return this.management.idleTimeoutMs(); }
  getLoggingConfig(): LoggingConfig { return this.logging; }
  getSyslogAgent(): SyslogAgent { return this.syslog; }
  getSyslogCollectors(): SyslogCollectorTable { return this.syslogCollectors; }

  syncSyslogAgent(): void { projectLoggingOntoSyslogAgent(this.logging, this.syslog); }

  logFirewallEvent(event: FirewallLogEvent, facts: FirewallLogFacts): void {
    emitFirewallEvent({
      catalog: this.profile.syslogCatalog,
      osName: this.profile.osName,
      logging: this.logging,
      syslog: this.syslog,
    }, event, facts);
  }

  clearTranslations(): number { return clearVdomTranslations(this.vdoms.all()); }

  setSchedule(schedule: ScheduleObject, vdom?: string): boolean {
    return this.getVdom(vdom).schedules.upsert(schedule);
  }

  setAllowedAccess(iface: string, services: readonly string[]): void {
    this.management.setAllowedAccess(iface, services);
  }

  allowsAccess(iface: string, service: string): boolean {
    return this.management.allowsAccess(iface, service);
  }

  allowedAccessOn(iface: string): readonly string[] {
    return this.management.allowedAccessOn(iface);
  }

  setManagementPorts(patch: Partial<ManagementPorts>): void {
    this.management.setManagementPorts(patch);
  }

  setAdminIdleTimeout(minutes: number): void { this.management.setIdleTimeout(minutes); }

  setAdminLockout(threshold: number, durationSec: number): void {
    this.management.setLockout(threshold, durationSec);
  }

  protected createManagementCli(_user: string): ManagementCli | null { return null; }

  protected managementRunningConfig(): string { return ''; }

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
  assignInterfaceToVdom(i: string, v: string): void { this.vdoms.assignInterface(i, v); }
  vdomOfInterface(i: string): string { return this.vdoms.vdomOfInterface(i); }
  createVdomLink(n: string): readonly string[] { return this.vdomLinks.create(n); }
  removeVdomLink(n: string): boolean { return this.vdomLinks.remove(n); }
  vdomLinkEnds(n: string): readonly string[] { return this.vdomLinks.ends(n); }
  vdomLinkPeer(i: string): string | undefined { return this.vdomLinks.peer(i); }

  setSwitchInterface(n: string, members: readonly string[]): void {
    this.switchGroups.set(n, members);
  }

  removeSwitchInterface(n: string): boolean { return this.switchGroups.remove(n); }
  switchInterfaces(): readonly string[] { return this.switchGroups.names(); }
  switchMembers(n: string): readonly string[] { return this.switchGroups.members(n); }

  sameSwitchInterface(left: string, right: string): boolean {
    return this.switchGroups.sameGroup(left, right);
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
    publishPoolProxyArp(this.proxyArp, pool);
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
    return this.pipelines.forMode(mode);
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
    return this.traces.recent(Math.max(1, limit));
  }

  clearTraces(): void { this.traces.clear(); }

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    this.capture.record({
      at: this.services.now(), iface: portName, direction: 'in', frame,
    });
    this.macTable.set(frame.srcMAC.toString(), portName);

    if (frame.etherType === ETHERTYPE_FGCP) {
      this.haService.agent.receive(frame);
      return;
    }
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

    const vdom = this.vdoms.contextOfInterface(portName);
    const decision = classifyIpv4(this.ingressHost(), portName, vdom, packet, frame);
    if (decision.kind === 'consumed') return;
    if (decision.kind === 'decapsulated') {
      this.handleIpv4Frame(decision.tunnel, decision.inner);
      return;
    }
    if (decision.kind === 'local') { this.deliverLocally(portName, packet); return; }

    const context = makePacketContext({
      ingressPort: portName, packet, arrivedAt: this.services.now(),
      ingressFrameDestination: frame?.dstMAC,
    });
    const outcome = this.processPipeline(context);
    this.traces.remember(context);
    this.logPipelineOutcome(context, outcome.verdict === 'accepted');
    if (outcome.verdict !== 'accepted') {
      if (context.verdict?.reason === 'auth-required') {
        this.captivePortal.capture(portName, packet);
      }
      return;
    }

    const forwarded = outcome.payload ?? context;
    if (forwarded.egressPort === undefined) return;
    this.forward(forwarded.egressPort, forwarded.packet as IPv4Packet,
      forwarded.policyRouteGateway,
      bridgedFrameOf(frame, forwarded.bridged === true
        || vdom.settings.opmode === 'transparent'));
  }

  private logPipelineOutcome(context: PacketContext, accepted: boolean): void {
    logPipelineOutcome(
      (event, facts) => { this.logFirewallEvent(event, facts); }, context,
      logFactsOf(context, this.vdoms.contextOfInterface(context.ingressPort).zones),
      accepted, this.trafficLogger);
  }

  private deliverLocally(portName: string, packet: IPv4Packet): void {
    deliverLocally({
      ikeDatagram: (p) => ikeDatagram(p),
      handleIke: (iface, p, d) => { this.ipsec.handleIkeUdp(iface, p, d as never); },
      observedBySdwan: (p) => this.dnsClient.observe(p)
        || this.traceroute.observe(p) || this.ping.observeReply(p)
        || this.sdwan.observeReply(p),
      handleTcp: (iface, p) => { this.tcp.handleIp(iface, p.sourceIP, p); },
      admitsTcp: (iface, p) => this.management.admitsTcp(iface, p),
      allowsPing: (iface) => this.allowsAccess(iface, 'ping'),
      reply: (iface, p) => { this.forward(iface, p); },
    }, portName, packet);
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
    return egressDepsOf({
      nextHopFor: (i, to) => this.vdoms.contextOfInterface(i).routes.resolveNextHop(to)?.nextHop,
      resolvedMac: (ip) => this.arp.resolved(ip),
      buildRequest: (ip, i) => this.arp.buildRequest(ip, i),
      portMac: (i) => this.portMac(i),
      sendFrame: (i, frame) => { this.sendFrame(i, frame); },
    });
  }

  private ingressHost(): Ipv4IngressHost {
    return ingressHostOf({
      l3: this.l3,
      captivePortal: this.captivePortal,
      interfaces: this.interfaces,
      vdomOf: (iface) => this.vdoms.contextOfInterface(iface),
      decapsulate: (p) => decryptFromTunnel(this.ipsec, this.getVdom().tunnels, p) ?? null,
    });
  }
}

function bridgedFrameOf(
  frame: EthernetFrame | undefined, bridged: boolean,
): BridgedFrame | undefined {
  return frame !== undefined && bridged
    ? { srcMAC: frame.srcMAC, dstMAC: frame.dstMAC }
    : undefined;
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
