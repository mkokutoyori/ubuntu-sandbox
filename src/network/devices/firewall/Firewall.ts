import { Equipment } from '../../equipment/Equipment';
import { LacpAgent } from '@/network/lacp/LacpAgent';
import type { AggregateSpec } from './l2/AggregateSpec';
import { buildUdpOverIpv4, type UdpSendRequest } from '../../layers/transport/UdpEgress';
import { Port } from '../../hardware/Port';
import { selectBundleMember } from '@/network/lacp/loadBalance';
import { aggregateAlgorithmToLoadBalance } from './l2/AggregateSpec';
import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ETHERTYPE_IPV6,
  IPv6Address,
  type IPv6Packet,
  IPAddress,
  IP_PROTO_UDP,
  MACAddress,
  type ARPPacket,
  type DeviceType,
  type EthernetFrame,
  type IPv4Packet,
  type UDPPacket,
} from '../../core/types';
import {
  buildICMPError, mayGenerateICMPError,
  ICMP_TTL_EXPIRED_IN_TRANSIT, ICMP_UNREACH_FRAG_NEEDED,
  ICMP_FRAG_REASSEMBLY_TIME_EXCEEDED,
} from '../../core/IcmpErrors';
import { fragmentIPv4, IPV4_FLAG_DF } from '../../core/Ipv4Fragmentation';
import { FragmentReassembly } from './l3/FragmentReassembly';
import { SystemClock } from '../../core/SystemClock';
import { SystemLoad, type MemoryWorkload } from './health/SystemLoad';
import { conserveLogDraft } from './health/ConserveEvent';
import { vdomFootprint, cacheFootprint } from './health/MemoryFootprint';
import { StreamAssembler, oversizeLimitBytes } from './inspection/StreamAssembler';
import { BridgeFdb } from './l2/BridgeFdb';
import { RevisionStore } from './config/RevisionStore';
import { LdbMonitorTable } from './health/LdbMonitor';
import { dialTcp, parseDialAddress } from '../../tcp/dial';
import { isDialFailure } from '../../tcp/types';
import { PortNumber } from '../../core/ports/PortNumber';
import {
  RealServerPool, type LdbMethod, type RealServer,
} from './nat/RealServerPool';
import { localTimeMs, utcMsForLocal } from '../../core/Timezone';
import { decryptFromTunnel, sealedLegs } from './vpn/IpsecDataPlane';
import { ikeDatagram, ipsecHostFacts } from './vpn/FirewallIpsecHost';
import { InterfaceTable, type InterfaceConfig } from './l3/InterfaceTable';
import { RouteTable, type DeclaredStaticRoute } from './l3/RouteTable';
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
  GENERIC_PROFILE, type DeploymentMode, type FirewallProfile, type FirewallPortSpec,
} from './FirewallProfile';
import { ROOT_VDOM, VdomRegistry, type VdomContext } from './vdom/VdomRegistry';
import { VdomLinkTable } from './vdom/VdomLinkTable';
import { clusterVirtualMac } from './ha/clusterVirtualMac';
import { ipv4HeaderProblem } from '../../layers/internet/InternetLayer';
import { SwitchGroupTable } from './l3/SwitchGroupTable';
import { logFactsOf } from './logging/logFacts';
import { emitFirewallEvent, logPipelineOutcome } from './logging/emitFirewallEvent';
import {
  arpFrame, buildEgressFrame, egressDepsOf, udpDatagram,
  type BridgedFrame, type EgressDeps,
} from './l3/FirewallEgress';
import { deliverLocally } from './l3/LocalDelivery';
import { ControlPlaneUdpEndpoint } from '../udp/ControlPlaneUdpEndpoint';
import type { FirewallDhcp } from './l3/FirewallDhcp';
import type { TcpStack } from '../../tcp/TcpStack';
import { buildFirewallAgents } from './FirewallAgents';
import { AccessMatrix } from './authz/AccessMatrix';
import { AuthPortal, type RemoteAuthOutcome } from './auth/AuthPortal';
import type { FirewallPortals, PortalPorts } from './auth/FirewallPortals';
import { remoteAuthenticate, type AdminAccountDraft } from './identity/AdminAccounts';
import type { PasswordHistory } from './identity/PasswordHistory';
import { FirewallIpv6 } from './l3/FirewallIpv6';
import type { PolicyProbe } from './policy/PolicyProbe';
import { isDenyAction } from './model/SecurityRule';
import { FirewallPing6 } from './diag/FirewallPing6';
import { getDefaultScheduler } from '@/events/Scheduler';
import type { Ipv6Counters } from '../router/IPv6DataPlane';
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
import type {
  AdminHttpApp, AdminHttpServer, AdminServerCertificate,
} from './mgmt/AdminHttpServer';
import type { ManagementCli } from './mgmt/FirewallCliServer';
import { ManagementPlane } from './mgmt/ManagementPlane';
import type { ManagementPorts } from './mgmt/ManagementAccess';
import type { CaptivePortalRedirect } from './auth/CaptivePortalRedirect';
import { SslDeepInspection } from './inspection/SslDeepInspection';
import { ModeCfgPool } from './vpn/ModeCfgPool';
import type { IkeConfigReply, IkeConfigRequest } from '../../ipsec/IPSecTypes';
import type { NtpAgent } from '../../ntp/NtpAgent';
import { FirewallPing, type FirewallPingEgress } from './diag/FirewallPing';
import { PingOptions } from './diag/PingOptions';
import { ConsoleSettings } from './mgmt/ConsoleSettings';
import { LoginBanners } from './mgmt/LoginBanners';
import { FirewallObservables } from './diag/FirewallObservables';
import type { HostObservables } from '../host/observables';
import {
  beginSniffer, type SnifferRun, type SnifferSelection,
} from './diag/FirewallSniffer';
import { buildEchoRequest } from '../../icmp/IcmpEcho';
import { FirewallTraceroute } from './diag/FirewallTraceroute';
import {
  DNS_PORT, FirewallDnsClient, dnsQueryDatagram,
} from './l3/FirewallDnsClient';
import { FirewallDnsServer } from './l3/FirewallDnsServer';
import type { SdwanService } from './sdwan/SdwanService';
import { ETHERTYPE_FGCP, type HaAgent } from './ha/HaAgent';
import { serialNumberOf, type FirewallHa } from './ha/FirewallHa';
import type { HaConfiguration } from './ha/HaTypes';
import type {
  SdwanConfiguration, SdwanHealthTransition, SdwanTable,
} from './sdwan/SdwanTable';
import type { SslVpnPortal, SslVpnSettings } from './vpn/SslVpnPortal';
import type { IPSecEngine } from '../../ipsec/IPSecEngine';
import { bringUpTunnel, programIpsecEngine } from './vpn/IpsecProgramming';
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

const ETHERNET_OVERHEAD_BYTES = 18;

function frameBytes(frame: EthernetFrame): number {
  const payload = frame.payload as { totalLength?: number } | undefined;
  return ETHERNET_OVERHEAD_BYTES + (payload?.totalLength ?? 46);
}

const ICMP_ERROR_TTL = 64;
const DEFAULT_INTERFACE_MTU = 1500;

export class Firewall extends Equipment {
  consoleLineCount(): number { return 1; }

  applyDeviceName(name: string): void {
    this.setName(name);
    this.setHostname(name);
  }

  private readonly interfaces = new InterfaceTable((name) => this.getPort(name));
  private readonly vdoms: VdomRegistry;
  private readonly switchGroups = new SwitchGroupTable();
  private readonly vdomLinks: VdomLinkTable;
  private readonly bridges = new Map<string, BridgeFdb>();
  private readonly fragments = new FragmentReassembly();

  private readonly ipv6 = new FirewallIpv6({
    id: this.id,
    name: this.name,
    ports: () => this.portMap(),
    sendFrame: (iface, frame) => { this.sendFrame(iface, frame); },
    bus: () => this.getBus(),
    scheduler: () => getDefaultScheduler(),
    managementAllows: (iface, service) => this.ipv6.allowsAccess(iface, service),
    onEchoReply: (payload) => { this.ping6.observeReply(payload); },
    transitPermitted: (probe) => this.ipv6TransitPermitted(probe),
    sessions: () => this.getSessionTable(),
  });

  private readonly ping6 = new FirewallPing6(() => this.ipv6.dataPlane());

  private readonly ipv6Routes = new Map<string, string>();
  private readonly revisions: RevisionStore;
  private revisionOnLogout = false;
  private configSnapshot?: () => string;
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
  private readonly sdwanRoutes = new Map<string, DeclaredStaticRoute>();
  private readonly routing: FirewallRouting;
  private readonly dhcp: FirewallDhcp;
  private readonly l3: L3Services;
  private readonly ntp: FirewallNtp;
  private readonly captivePortal: CaptivePortalRedirect;
  private authPortalSecureHttp = false;
  private readonly modeCfg = new ModeCfgPool();
  private readonly deepInspection = new SslDeepInspection({
    tcp: () => this.tcp,
    localCertificate: (name) => this.getCertificateStore().local(name),
    trustAnchors: () => this.getCertificateStore().trustAnchors(),
    matchesAddress: (name, candidate) =>
      this.getObjectStore().matchesAddress(name, candidate),
    now: () => this.services.now(),
    claimPort: (port) => { this.adminServer?.yieldPort(port); },
    releasePort: (port) => { this.adminServer?.reclaimPort(port); },
  });
  private adminServer: AdminHttpServer | null = null;
  private readonly management: ManagementPlane;
  private readonly load: SystemLoad;
  private readonly streams = new StreamAssembler();
  private readonly serverPools = new Map<string, RealServerPool>();
  private readonly poolMonitors = new Map<string, string[]>();
  private readonly ldbMonitors = new LdbMonitorTable({
    ping: async (address) => this.ping.begin(address)?.step(1) !== null,
    tcp: async (address, port) => {
      const destination = parseDialAddress(address);
      if (!destination || !PortNumber.isValid(port)) return false;
      const outcome = await dialTcp(this.tcp, destination, PortNumber.of(port));
      if (isDialFailure(outcome)) return false;
      outcome.close();
      return true;
    },
  });

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
  private readonly fqdnVips = new Map<string, () => void>();

  static chassisPorts(profile: FirewallProfile): readonly FirewallPortSpec[] {
    if (profile.ports !== undefined) return profile.ports;
    const first = profile.portFirstIndex;
    return Array.from({ length: profile.portCount }, (_unused, offset) => ({
      name: `${profile.portPrefix}${first + offset}`,
      role: 'undefined' as const,
    }));
  }

  constructor(
    deviceType: DeviceType, name: string, x = 0, y = 0, options: FirewallOptions = {},
  ) {
    super(deviceType, name, x, y);

    this.attachReassemblyTimeout();

    const profile = options.profile ?? GENERIC_PROFILE;
    this.profile = profile;
    this.pipelines = new PipelineCache(this.id, profile, this.registry);

    for (const declare of Firewall.chassisPorts(profile)) {
      const port = new Port(declare.name, 'ethernet');
      this.addPort(port);
      this.watchBridgePort(port);
      this.interfaces.configure(port.getName(), {
        up: port.getIsUp(),
        ...(declare.ip ? { ip: declare.ip, mask: declare.mask } : {}),
      });
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
    this.load = new SystemLoad({
      now,
      cpuCount: profile.chassis.cpuCount,
      memoryKib: profile.chassis.memoryMb * 1024,
      baseMemoryKib: profile.chassis.firmwareMemoryMb * 1024,
      packetsPerSecondPerCpu: profile.chassis.packetsPerSecondPerCpu,
      onConserveChange: (transition) => {
        this.getLogStore().append(conserveLogDraft(now(), transition));
      },
    });
    this.load.addWorkload(() => this.measureWorkload());
    this.revisions = new RevisionStore({ now });
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
      predefinedAddresses: profile.predefinedAddresses,
      predefinedServices: profile.predefinedServices,
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
        this.streams.forget(session.c2s);
        this.trafficLogger?.onSessionClosed(session, reason);
        this.sessionObserver?.(session, reason);
      },
      realServerPool: (name) => this.serverPools.get(name),
      onSessionCountChanged: (count, created) => {
        this.load.observeSessionCount(count);
        if (created) this.load.recordSessionCreated();
        this.load.reassess();
      },
    });
    this.arp = new ArpService({
      interfaces: this.interfaces,
      macOf: (iface) => this.portMac(iface),
      now,
      onRequestNeeded: (request, iface) => this.emitArp(request, iface),
      proxyOwns: (address, iface) => this.proxyArpAnswers(address, iface),
      onCacheChanged: () => { this.liveState.refresh(); },
    });

    this.services = {
      interfaces: this.interfaces,
      vdomOf: (iface) => vdomServices(this.vdoms.contextOfInterface(iface)),
      sdwan: () => this.sdwan,
      ha: () => ({ forwardsTransit: () => this.forwardsTransit() }),
      policyKeyedBy: profile.policyKeyedBy,
      refusesNewSessions: () => this.load.refusesNewSessions(),
      proxyInspectionPosture: () => this.load.proxyInspectionPosture(),
      flowInspectionPosture: () => this.load.flowInspectionPosture(),
      assembleStream: (key, chunk, limitMb) =>
        this.streams.append(key, chunk, oversizeLimitBytes(limitMb)),
      onInspection: () => { this.load.recordPacket('inspection'); },
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
      sendArpAware: (p, packet, nextHop) =>
        this.sendIpv4FrameArpAware(p, packet, nextHop),
      sendUdpDatagram: (request) => this.sendUdpDatagram(request),
      sourceAddressFor: (destination) => this.sourceAddressFor(destination),
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
      sendArpAware: (iface, ipPkt, nextHopIP) =>
        this.sendIpv4FrameArpAware(iface, ipPkt, nextHopIP),
      sendFrame: (iface, frame) => { this.sendFrame(iface, frame); },
      sessions: () => this.getVdom().sessions,
      connectedRoutes: () => this.interfaces.connectedRoutes(),
      addressOf: (iface) => this.interfaces.get(iface)?.ip,
      authenticated: (iface, address) =>
        this.vdoms.contextOfInterface(iface).identities.lookup(address) !== undefined,
      authRequiredByPolicy: () => this.getVdom().policy.ordered()
        .some(r => (r.authUsers?.length ?? 0) > 0 || (r.authGroups?.length ?? 0) > 0),
      portalUsesHttps: () => this.authPortalSecureHttp,
      managementPorts: () => this.management.managementPorts(),
      createManagementCli: (user, origin) => this.createManagementCli(user, origin),
      authenticateAdmin: (user, password, source) =>
        this.management.login(user, password, source),
      knownAdmin: (user) => this.access.getAdmin(user) !== undefined,
      refuseManagementSource: (source) => this.management.refusesSource(source),
      managementIdleTimeoutMs: () => this.management.idleTimeoutMs(),
      runningConfig: () => this.managementRunningConfig(),
      onManagementLogin: (user) => { this.management.noteLogin(user); },
      onAdminLogout: (user) => { this.onAdminLogout(user); },
      onManagementAuthFailure: (user) => {
        this.management.noteAuthFailure(user);
      },
      loginBannerLines: (stage) => this.loginBanners.lines(stage),
      adminHttpsRedirect: () => this.management.adminHttpsRedirect(),
      adminServerCertificate: () => this.adminServerCertificate(),
      managementServedAnywhere: (service) => this.management.servedAnywhere(service),
      adminHttpApp: () => this.adminHttpApp(),
    });
    this.portals = mgmt.portals;
    this.portal = mgmt.portals.auth;
    this.sslVpn = mgmt.portals.sslVpn;
    this.haService = mgmt.ha;
    this.ntp = mgmt.ntp;
    this.captivePortal = mgmt.captivePortal;
    this.management.attachCliServer(mgmt.cli);
    this.adminServer = mgmt.admin;
    this.management.attachAdminServer(mgmt.admin);

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
      emitArpAware: (iface, packet, nextHop) =>
        this.sendIpv4FrameArpAware(iface, packet, nextHop),
      assignAddress: (iface, ip, mask) => { this.configureInterface(iface, { ip, mask }); },
      forward: (iface, packet, gateway) => { this.forward(iface, packet, gateway); },
      systemDnsServers: () => {
        const settings = this.dnsClient.getSettings();
        return [settings.primary, settings.secondary]
          .filter(server => server.length > 0 && server !== '0.0.0.0');
      },
    });

    this.l3 = l3;
    this.routing = l3.routing;
    this.dhcp = l3.dhcp;
    this.sdwan = l3.sdwan;
    this.sdwan.onHealthChange((changes) => { this.onSdwanHealthChange(changes); });
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

  private readonly liveState = new FirewallObservables({
    arp: () => this.arp,
    routes: () => this.getVdom().routes,
    tcp: () => this.tcp,
  });

  readonly observables: HostObservables = this.liveState.published;

  refreshLiveState(): void { this.liveState.refresh(); }

  private readonly ping = new FirewallPing({
    resolve: (destination) => this.resolveEgress(destination),
    send: (iface, packet, gateway) => {
      this.liveState.countEchoSent();
      this.forward(iface, packet, gateway);
    },
    options: () => this.pingOptions,
    onReply: (payload) => {
      this.liveState.countEchoReceived();
      this.getBus().publish({
        topic: 'host.icmp.echo-reply',
        payload: { deviceId: this.id, hostname: this.getHostname(), rttMs: 0, ...payload },
      });
    },
  });

  runPing(target: string, count?: number): string { return this.ping.run(target, count); }

  beginPing(target: string) { return this.ping.begin(target); }

  pingRepeatCount(): number { return this.ping.defaultCount(); }

  getPingOptions(): PingOptions { return this.pingOptions; }

  getConsoleSettings(): ConsoleSettings { return this.consoleSettings; }

  getLoginBanners(): LoginBanners { return this.loginBanners; }

  beginSniffer(selection: SnifferSelection): SnifferRun {
    const capture = this.capture;
    return beginSniffer({
      observe: (listener) => capture.observe(listener),
    }, selection);
  }

  shutdownNow(): void { this.powerOff(); }

  rebootNow(): void {
    this.powerOff();
    this.powerOn();
  }

  private resolveEgress(destination: string): FirewallPingEgress | null {
    const route = this.getVdom().routes.resolveNextHop(destination);
    const iface = route?.iface ?? this.interfaces.interfaceForDestination(destination);
    const source = iface === undefined ? undefined : this.interfaces.get(iface)?.ip;
    if (iface === undefined || source === undefined) {
      this.rememberUnroutable(destination);
      return null;
    }
    return { iface, gateway: route?.nextHop, source };
  }

  private rememberUnroutable(destination: string): void {
    const context = makePacketContext({
      ingressPort: 'local',
      packet: buildEchoRequest('0.0.0.0', destination, 0, 0),
      arrivedAt: this.services.now(),
    });
    context.verdict = { action: 'drop', reason: 'no-route', stage: 'route-lookup' };
    this.traces.remember(context);
  }

  private readonly pingOptions = new PingOptions();

  private readonly consoleSettings = new ConsoleSettings();
  private readonly loginBanners = new LoginBanners();

  private readonly traceroute = new FirewallTraceroute({
    resolve: (destination) => this.resolveEgress(destination),
    send: (iface, packet, gateway) => { this.forward(iface, packet, gateway); },
  });

  runTraceroute(target: string): string { return this.traceroute.run(target); }

  private readonly dnsClient = new FirewallDnsClient({
    send: (destination, sourcePort, payload) => {
      const egress = this.resolveEgress(destination);
      if (!egress) return false;
      this.forward(egress.iface,
        dnsQueryDatagram(egress.source, destination, sourcePort, payload), egress.gateway);
      return true;
    },
  });

  getDnsClient(): FirewallDnsClient { return this.dnsClient; }

  private udpEndpoint: ControlPlaneUdpEndpoint | null = null;

  getUdpEndpoint(): ControlPlaneUdpEndpoint {
    if (!this.udpEndpoint) {
      this.udpEndpoint = new ControlPlaneUdpEndpoint({
        sendUdpBytes: (destinationIP, destinationPort, sourcePort, payload) => {
          const egress = this.resolveEgress(destinationIP.toString());
          if (!egress) return false;
          this.forward(
            egress.iface,
            udpDatagram(egress.source, destinationIP.toString(),
              sourcePort, destinationPort, payload),
            egress.gateway);
          return true;
        },
      });
    }
    return this.udpEndpoint;
  }

  private deliverToUdpSocket(packet: IPv4Packet): boolean {
    if (packet.protocol !== IP_PROTO_UDP || this.udpEndpoint === null) return false;
    const udp = packet.payload as UDPPacket | undefined;
    if (udp?.type !== 'udp') return false;
    return this.udpEndpoint.deliver(
      packet.sourceIP, udp.destinationPort, udp.sourcePort, udp.payload);
  }

  private readonly dnsServer = new FirewallDnsServer({
    resolveExternal: (name) => this.dnsClient.resolve(name),
    reply: (iface, to, port, payload) => {
      const source = this.interfaces.get(iface)?.ip;
      if (source === undefined) return;
      this.forward(iface,
        udpDatagram(source, to, DNS_PORT, port, payload),
        this.getVdom().routes.resolveNextHop(to)?.nextHop);
    },
  });

  getDnsServer(): FirewallDnsServer { return this.dnsServer; }

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

  forwardsTransit(): boolean {
    const ha = this.haService.agent;
    return ha.getConfiguration().mode !== 'a-p' || ha.role() !== 'slave';
  }

  applyHa(c: HaConfiguration): string | undefined {
    this.haService.agent.configure(c);
    this.applyClusterVirtualMacs(c);
    return undefined;
  }

  private readonly permanentMacs = new Map<string, MACAddress>();

  private applyClusterVirtualMacs(c: HaConfiguration): void {
    const heartbeat = new Set(c.heartbeatDevices.map((d) => d.iface));
    this.getPorts().forEach((port, index) => {
      const name = port.getName();
      if (!this.permanentMacs.has(name)) this.permanentMacs.set(name, port.getMAC());
      const permanent = this.permanentMacs.get(name);
      if (!permanent) return;
      port.setMAC(c.mode === 'standalone' || heartbeat.has(name)
        ? permanent
        : clusterVirtualMac(c.groupId, index));
    });
  }

  private readonly serial: string = serialNumberOf(this.name);

  serialNumber(): string { return this.serial; }
  applySdwan(c: SdwanConfiguration): string | undefined {
    const refusal = this.sdwan.apply(c);
    if (refusal === undefined) this.refreshSdwanRoutes();
    return refusal;
  }

  getSdwanTable(): SdwanTable { return this.sdwan.getTable(); }
  runSdwanHealthChecks(): Promise<void> { return this.sdwan.runHealthChecks(); }

  applySdwanStaticRoute(route: DeclaredStaticRoute): void {
    this.sdwanRoutes.delete(route.id);
    const routes = this.getRouteTable();
    routes.removeStaticById(route.id);
    routes.removeStaticsBySource(route.id);
    if (!route.enabled || route.blackhole) return;

    if (this.sdwan.getTable().membersOfZone(route.iface).length > 0) {
      this.sdwanRoutes.set(route.id, route);
      this.installSdwanRoute(route);
      return;
    }

    routes.addStatic(route.destination, route.mask,
      route.gateway === '0.0.0.0' ? undefined : route.gateway,
      {
        iface: route.iface || undefined, distance: route.distance,
        priority: route.priority, id: route.id,
      });
  }

  forgetSdwanStaticRoute(id: string): void { this.sdwanRoutes.delete(id); }

  private installSdwanRoute(route: DeclaredStaticRoute): void {
    const table = this.sdwan.getTable();
    for (const member of table.membersOfZone(route.iface)) {
      if (!this.memberCarriesRoutes(member.sequence)) continue;
      this.getRouteTable().addStatic(route.destination, route.mask,
        member.gateway === '0.0.0.0' ? undefined : member.gateway,
        {
          iface: member.iface, distance: route.distance,
          priority: member.priority, id: `${route.id}:sdwan-${member.sequence}`,
        });
    }
  }

  private memberCarriesRoutes(sequence: number): boolean {
    const table = this.sdwan.getTable();
    for (const check of table.allHealthChecks()) {
      if (!check.members.includes(sequence)) continue;
      if (!check.updateStaticRoute) continue;
      if (table.healthOf(check.name, sequence)?.alive === false) return false;
    }
    return true;
  }

  private refreshSdwanRoutes(): void {
    for (const route of [...this.sdwanRoutes.values()]) {
      this.applySdwanStaticRoute(route);
    }
  }

  private onSdwanHealthChange(changes: readonly SdwanHealthTransition[]): void {
    for (const route of this.sdwanRoutes.values()) {
      this.getRouteTable().removeStaticsBySource(route.id);
      this.installSdwanRoute(route);
    }
    for (const change of changes) {
      if (change.alive) continue;
      const member = this.sdwan.getTable().member(change.sequence);
      if (member) this.closeSessionsOn(member.iface);
    }
  }

  private closeSessionsOn(iface: string): void {
    this.getVdom().sessions.clearMatching(
      session => session.egressInterface === iface);
  }

  bindHaConfiguration(read: () => string, apply: (text: string) => void): void {
    this.haService.bindConfiguration(read, apply);
  }

  applySslVpnSettings(s: SslVpnSettings): string | undefined { return this.sslVpn.apply(s); }

  syncIpsecTunnels(v?: string) {
    const vdom = this.getVdom(v);
    programIpsecEngine(this.ipsec, vdom.tunnels, vdom.certificates, this.services.now);
    this.ipsec.setConfigMethod((peer, request) => this.answerConfigMethod(peer, request));
  }

  getModeCfgPool(): ModeCfgPool { return this.modeCfg; }

  private answerConfigMethod(
    peer: string, request: IkeConfigRequest,
  ): IkeConfigReply | string | undefined {
    if (!request.wantAddress) return undefined;

    const tunnel = this.getVdom().tunnels.all()
      .find(entry => this.modeCfg.configuredFor(entry));
    if (!tunnel) return 'IPv4 pool is not configured';

    if (tunnel.authUserGroup !== undefined) {
      const directory = this.getUserDirectory();
      const user = request.identity ?? '';
      const admitted = user.length > 0
        && directory.authenticateLocal(user, request.credential ?? '')
        && directory.groupsOf(user).includes(tunnel.authUserGroup);
      if (!admitted) return 'AUTHENTICATION_FAILED';
    }

    const assignment = this.modeCfg.assign(tunnel, peer, request.identity);
    if (assignment === undefined) return 'IPv4 pool is not configured';
    if (assignment === 'exhausted') return 'IPv4 address pool is exhausted';

    return {
      address: assignment.address,
      netmask: assignment.netmask,
      splitInclude: this.splitSubnetsOf(assignment.splitInclude),
      dnsServers: assignment.dnsServers,
    };
  }

  private splitSubnetsOf(name: string | undefined): readonly string[] {
    if (name === undefined) return [];
    const object = this.getObjectStore().getAddress(name);
    if (object?.value === undefined) return [];
    return object.careMask === undefined
      ? [object.value]
      : [`${object.value}/${object.careMask}`];
  }

  bringUpIpsecTunnel(name: string, v?: string): boolean {
    const brought = bringUpTunnel(this.ipsec, this.getVdom(v).tunnels, name);
    this.applyAssignedConfiguration(name, v);
    return brought;
  }

  private applyAssignedConfiguration(name: string, v?: string): void {
    const vdom = this.getVdom(v);
    const assignment = vdom.tunnels.receivedAssignment(name);
    if (!assignment) return;

    this.interfaces.configure(name, {
      up: true, ip: assignment.address, mask: assignment.netmask,
    });
    for (const subnet of assignment.splitInclude) {
      const [network, mask] = subnet.split('/');
      vdom.routes.addStatic(network, mask ?? '255.255.255.255', undefined, {
        iface: name, id: `modecfg:${name}:${network}`,
      });
    }
  }

  clearIpsecGateway(name: string, v?: string): void {
    const tunnels = this.getVdom(v).tunnels;
    const tunnel = tunnels.getPhase1(name);
    if (!tunnel) return;

    this.ipsec.clearAllSAs();
    tunnels.markDown(name, null);
    tunnels.markGateway(name, false);
    bringUpTunnel(this.ipsec, tunnels, name);
  }

  private sendUdpToPeer(destIp: string, port: number, payload: unknown): boolean {
    const route = this.getVdom().routes.resolveNextHop(destIp);
    const iface = route?.iface ?? this.interfaces.interfaceForDestination(destIp);
    const source = iface === undefined ? undefined : this.interfaces.get(iface)?.ip;
    if (iface === undefined || source === undefined) return false;

    this.forward(iface, udpDatagram(source, destIp, port, port, payload), route?.nextHop);
    return true;
  }

  sourceAddressFor(destination: IPAddress): IPAddress | null {
    const target = destination.toString();
    const route = this.getVdom().routes.resolveNextHop(target);
    const iface = route?.iface ?? this.interfaces.interfaceForDestination(target);
    const source = iface === undefined ? undefined : this.interfaces.get(iface)?.ip;
    return source === undefined ? null : new IPAddress(source);
  }

  sendUdpDatagram(request: UdpSendRequest): boolean {
    const target = request.destination.toString();
    const route = this.getVdom().routes.resolveNextHop(target);
    const iface = route?.iface ?? this.interfaces.interfaceForDestination(target);
    const source = request.source?.toString()
      ?? (iface === undefined ? undefined : this.interfaces.get(iface)?.ip);
    if (iface === undefined || source === undefined) return false;

    this.forward(iface, buildUdpOverIpv4(new IPAddress(source), request), route?.nextHop);
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

  setAuthPortalSecureHttp(on: boolean): void { this.authPortalSecureHttp = on; }
  authPortalUsesHttps(): boolean { return this.authPortalSecureHttp; }

  getAuthPortalPorts(): PortalPorts { return this.portals.ports(); }
  startAuthPortal(): boolean { return this.portals.startAuth(); }

  applyAdminAccount(admin: AdminAccountDraft): void { this.management.applyAdmin(admin); }

  getPasswordHistory(): PasswordHistory { return this.management.passwordHistory(); }

  adminNames(): readonly string[] { return this.access.adminNames(); }

  getAdminAccount(name: string) { return this.access.getAdmin(name); }

  adminMustChoosePassword(name: string): boolean {
    return this.management.requiresPasswordChange(name);
  }

  authenticateAdmin(name: string, password: string, source?: string): boolean {
    return this.management.login(name, password, source);
  }

  adminIsLockedOut(name: string): boolean {
    return this.management.isLockedOut(name);
  }

  adminTrustsSource(name: string, source: string): boolean {
    return this.management.trustsSource(name, source);
  }

  configureInterface(name: string, config: InterfaceConfig): void {
    this.interfaces.configure(name, config);
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
    const accepted = this.processPipeline(context).verdict === 'accepted';
    this.traces.remember(context);
    return summariseSimulation(context, accepted);
  }

  setInterfaceMtu(name: string, mtu: number | undefined): void {
    this.interfaces.configure(name, { mtu: mtu ?? DEFAULT_INTERFACE_MTU });
  }

  setInterfaceUp(name: string, up: boolean): void {
    this.adminIntent.set(name, up);
    this.interfaces.setUp(name, up);
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

  setAdminHttpsRedirect(enabled: boolean): void {
    this.management.setAdminHttpsRedirect(enabled);
  }

  setAdminServerCertificate(name: string): void {
    this.management.setAdminServerCertificate(name);
  }

  protected adminHttpApp(): AdminHttpApp | null { return null; }

  private adminServerCertificate(): AdminServerCertificate | undefined {
    const declared = this.getCertificateStore()
      .local(this.management.adminServerCertificateName());
    return declared === undefined
      ? undefined
      : { certificate: declared.certificate, privateKey: declared.privateKey };
  }



  setAdminLockout(threshold: number, durationSec: number): void {
    this.management.setLockout(threshold, durationSec);
  }

  protected createManagementCli(
    _user: string, _origin: string,
  ): ManagementCli | null { return null; }

  protected managementRunningConfig(): string { return ''; }

  getRunningConfig(): string { return this.managementRunningConfig(); }

  async replayConfig(text: string): Promise<void> {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0) await this.executeCommand(trimmed);
    }
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

  vdomNames(): readonly string[] { return this.vdoms.names(); }
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
  getSystemLoad(): SystemLoad { return this.load; }

  getStreamAssembler(): StreamAssembler { return this.streams; }

  private measureWorkload(): MemoryWorkload {
    let used = 0;
    let freeable = 0;
    for (const context of this.vdoms.all()) {
      const footprint = vdomFootprint({
        sessions: context.sessions.count(),
        policies: context.policy.ordered().length,
        addresses: context.objects.listAddresses().length,
        services: context.objects.listServices().length,
        routes: context.routes.all().length,
        logReserveBytes: context.logs.getMaxBytes() ?? 0,
        logRecordBytes: context.logs.usedBytes(),
      });
      used += footprint.usedBytes;
      freeable += footprint.freeableBytes;
    }
    const caches = cacheFootprint(this.arp.getCache().size);
    return { usedBytes: used + caches.usedBytes, freeableBytes: freeable + caches.freeableBytes };
  }

  getObjectStore(vdom?: string): ObjectStore { return this.getVdom(vdom).objects; }
  getPolicyStore(vdom?: string): PolicyStore { return this.getVdom(vdom).policy; }
  getSessionTable(vdom?: string): SessionTable { return this.getVdom(vdom).sessions; }
  getRouteTable(vdom?: string): RouteTable { return this.getVdom(vdom).routes; }
  getArpService(): ArpService { return this.arp; }
  bindFqdnVip(name: string, apply: () => void): void {
    this.fqdnVips.set(name, apply);
    apply();
  }

  unbindFqdnVip(name: string): void { this.fqdnVips.delete(name); }

  refreshFqdnVips(): void {
    for (const apply of this.fqdnVips.values()) apply();
  }

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

  private lacpAgentInstance: LacpAgent | null = null;
  private readonly aggregates = new Map<string, AggregateSpec>();

  getLacpAgent(): LacpAgent {
    if (!this.lacpAgentInstance) {
      this.lacpAgentInstance = new LacpAgent(
        {
          id: this.id, name: this.name,
          getHostname: () => this.getHostname(),
          getPort: (n: string) => this.getPort(n),
          getPorts: () => this.getPorts(),
          sendOnLink: (request) => this.getLinkLayer().send(request),
        },
        () => this.getBus(),
        this.getPorts()[0]?.getMAC().toString() ?? '00:00:00:00:00:00',
      );
      this.lacpAgentInstance.start();
    }
    return this.lacpAgentInstance;
  }

  getAggregates(): ReadonlyMap<string, AggregateSpec> { return this.aggregates; }

  declareAggregate(name: string, spec: AggregateSpec): void {
    const ancien = this.aggregates.get(name);
    if (ancien) for (const m of ancien.members) this.releaseAggregateMember(m);
    this.aggregates.set(name, spec);
    const primaire = this.getPort(spec.members[0] ?? '');
    if (!this.getPort(name)) {
      const nic = new Port(name, 'ethernet',
        primaire ? new MACAddress(primaire.getMAC().toString()) : undefined,
        { carrierless: true });
      nic.setUp(false);
      this.addPort(nic);
      this.interfaces.reproject(name);
    }
    for (const m of spec.members) this.adoptAggregateMember(name, m);
    this.applyAggregate(name);
  }

  removeAggregate(name: string): void {
    const spec = this.aggregates.get(name);
    if (spec) for (const m of spec.members) this.releaseAggregateMember(m);
    this.aggregates.delete(name);
    this.ports.delete(name);
  }

  isPhysicalPort(name: string): boolean {
    return this.getPort(name) !== undefined && !this.aggregates.has(name);
  }

  aggregateOwning(member: string): string | null {
    for (const [name, spec] of this.aggregates) {
      if (spec.members.includes(member)) return name;
    }
    return null;
  }

  private readonly aggregateSavedMacs = new Map<string, string>();

  permanentMacOf(member: string): string {
    return this.aggregateSavedMacs.get(member)
      ?? this.getPort(member)?.getMAC().toString()
      ?? '00:00:00:00:00:00';
  }

  private adoptAggregateMember(aggregate: string, member: string): void {
    const nic = this.getPort(aggregate);
    const port = this.getPort(member);
    if (!nic || !port) return;
    if (!this.aggregateSavedMacs.has(member)) {
      this.aggregateSavedMacs.set(member, port.getMAC().toString());
    }
    port.setMAC(new MACAddress(nic.getMAC().toString()));
    port.onLinkChange(() => this.refreshAggregates());
  }

  private releaseAggregateMember(member: string): void {
    this.getLacpAgent().removePort(member);
    const rendue = this.aggregateSavedMacs.get(member);
    if (rendue) {
      this.getPort(member)?.setMAC(new MACAddress(rendue));
      this.aggregateSavedMacs.delete(member);
    }
  }

  activeAggregateMembers(name: string): string[] {
    const spec = this.aggregates.get(name);
    if (!spec) return [];
    const agent = this.getLacpAgent();
    return spec.members.filter((m) => {
      if (this.getPort(m)?.isOperationallyUp() !== true) return false;
      return spec.lacpMode === 'static' || agent.getPortInfo(m)?.bundled === true;
    });
  }

  protected override aggregateMemberFor(
    portName: string, frame: EthernetFrame,
  ): string | null | undefined {
    const spec = this.aggregates.get(portName);
    if (!spec) return undefined;
    return selectBundleMember(this.activeAggregateMembers(portName), frame,
      aggregateAlgorithmToLoadBalance(spec.algorithm));
  }

  protected override aggregateIngressPort(portName: string): string | undefined {
    return this.aggregateOwning(portName) ?? undefined;
  }

  private readonly adminIntent = new Map<string, boolean>();

  private aggregateGroupId(name: string): number {
    const m = /(\d+)$/.exec(name);
    return m ? Number(m[1]) : 1;
  }

  private applyAggregate(name: string): void {
    const spec = this.aggregates.get(name);
    if (!spec) return;
    const agent = this.getLacpAgent();
    agent.setGroupLimits(this.aggregateGroupId(name), { minLinks: spec.minLinks });
    const mode = spec.lacpMode === 'static' ? 'on' : spec.lacpMode;
    for (const membre of spec.members) {
      if (!this.getPort(membre)) continue;
      agent.addPortToGroup(membre, this.aggregateGroupId(name), mode);
      agent.setPortFastRate(membre, spec.lacpSpeed === 'fast' ? true : null);
    }
    this.refreshAggregates();
  }

  private refreshAggregates(): void {
    for (const [name, spec] of this.aggregates) {
      const actifs = this.activeAggregateMembers(name);
      const assez = actifs.length > 0 && actifs.length >= spec.minLinks;
      const up = assez && (this.adminIntent.get(name) ?? true);
      if (spec.minLinksDown === 'administrative') this.interfaces.setUp(name, up);
      else this.getPort(name)?.setUp(up);
    }
  }

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    this.load.recordPacket('kernel');
    this.load.recordBytes('in', frameBytes(frame));
    this.capture.record({
      at: this.services.now(), iface: portName, direction: 'in', frame,
    });
    this.bridgeOf(portName).learn(frame.srcMAC.toString(), portName);
    if (!this.acceptsAtLinkLayer(portName, frame)) return;

    if (frame.etherType === ETHERTYPE_FGCP) {
      this.haService.agent.receive(frame);
      return;
    }
    if (frame.etherType === 0x8809) {
      this.getLacpAgent().handleFrame(portName, frame);
      this.refreshAggregates();
      return;
    }
    const logical = this.aggregateIngressPort(portName);
    if (logical !== undefined
      && frame.srcMAC.equals(this.getPort(portName)?.getMAC() ?? frame.dstMAC)) return;
    const iface = logical ?? portName;

    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleArpFrame(iface, frame.payload as ARPPacket);
      return;
    }
    if (frame.etherType === ETHERTYPE_IPV6) {
      this.ipv6.dataPlane().processPacket(
        iface, frame.payload as IPv6Packet, frame.srcMAC);
      return;
    }
    if (frame.etherType === ETHERTYPE_IPV4) {
      this.handleIpv4Frame(iface, frame.payload as IPv4Packet, frame);
    }
  }

  sendFrame(portName: string, frame: EthernetFrame): boolean {
    if (this.subordinateIsSilentOn(portName) && !this.secondarySpeaksLacpOn(portName, frame)) {
      return false;
    }
    return super.sendFrame(portName, frame);
  }

  private secondarySpeaksLacpOn(portName: string, frame: EthernetFrame): boolean {
    if (frame.etherType !== 0x8809) return false;
    const owner = this.aggregateOwning(portName);
    return owner !== null && this.aggregates.get(owner)?.lacpHaSecondary === true;
  }

  private subordinateIsSilentOn(portName: string): boolean {
    const ha = this.haService.agent;
    const config = ha.getConfiguration();
    if (config.mode !== 'a-p' || ha.role() !== 'slave') return false;
    return !config.heartbeatDevices.some((device) => device.iface === portName);
  }

  private acceptsAtLinkLayer(portName: string, frame: EthernetFrame): boolean {
    if (this.vdoms.contextOfInterface(portName).settings.opmode === 'transparent') return true;
    return this.getLinkLayer().deliver(portName, frame) !== null;
  }

  private lookupMac(destination: MACAddress, ingress: string): string | undefined {
    const learned = this.bridgeOf(ingress).lookup(destination.toString());
    return learned === undefined || learned === ingress ? undefined : learned;
  }

  getRevisions(): RevisionStore { return this.revisions; }

  getLdbMonitors(): LdbMonitorTable { return this.ldbMonitors; }

  getFragmentReassembly(): FragmentReassembly { return this.fragments; }

  private attachReassemblyTimeout(): void {
    this.fragments.setTimeoutHandler((firstFragment, ingressPort) => {
      this.sendIcmpError(ingressPort, firstFragment, 'time-exceeded',
        ICMP_FRAG_REASSEMBLY_TIME_EXCEEDED, {});
    });
  }

  private portMap(): Map<string, Port> {
    const map = new Map<string, Port>();
    for (const port of this.getPorts()) map.set(port.getName(), port);
    return map;
  }

  getIpv6(): FirewallIpv6 { return this.ipv6; }

  getIpv6Counters(): Ipv6Counters { return this.ipv6.counterView(); }

  configureIpv6Interface(iface: string, address: string, prefixLength: number): boolean {
    return this.ipv6.dataPlane()
      .configureInterface(iface, new IPv6Address(address), prefixLength);
  }

  setIpv6AllowAccess(iface: string, services: readonly string[]): void {
    this.ipv6.setAllowAccess(iface, services);
  }

  getPing6(): FirewallPing6 { return this.ping6; }

  private ipv6TransitPermitted(probe: PolicyProbe): boolean {
    const vdom = this.getVdom();
    const decision = vdom.evaluator.evaluate(vdom.policy.ordered(), probe);
    return !isDenyAction(decision.action);
  }

  applyIpv6StaticRoute(route: {
    id: string; destination: string; prefixLength: number;
    gateway: string; iface: string; distance: number; enabled: boolean;
  }): void {
    this.removeIpv6StaticRoute(route.id);
    if (!route.enabled) return;
    this.ipv6Routes.set(route.id, route.destination);
    this.ipv6.dataPlane().addStaticRoute(
      new IPv6Address(route.destination), route.prefixLength,
      new IPv6Address(route.gateway), route.iface, route.distance);
  }

  removeIpv6StaticRoute(id: string): void {
    const destination = this.ipv6Routes.get(id);
    if (destination === undefined) return;
    this.ipv6Routes.delete(id);
    this.ipv6.dataPlane().setRoutingTable(
      this.ipv6.dataPlane().getRoutingTableInternal()
        .filter(route => !(route.type !== 'connected'
          && route.prefix.toString() === destination)));
  }

  getRealServerPool(name: string): RealServerPool | undefined {
    return this.serverPools.get(name);
  }

  applyRealServerPool(
    name: string, method: LdbMethod, servers: readonly RealServer[],
    monitors: readonly string[],
  ): void {
    const pool = this.serverPools.get(name)
      ?? new RealServerPool(name, method, {
        sessionsTo: (address, port) => this.sessionsTo(address, port),
      });
    pool.setMethod(method);
    pool.setServers(servers);
    this.serverPools.set(name, pool);
    this.poolMonitors.set(name, [...monitors]);
  }

  removeRealServerPool(name: string): void {
    this.serverPools.delete(name);
    this.poolMonitors.delete(name);
  }

  async runLdbMonitors(): Promise<void> {
    for (const [name, pool] of this.serverPools) {
      const monitors = this.poolMonitors.get(name) ?? [];
      for (const server of pool.list()) {
        const alive = await this.ldbMonitors.check(
          monitors, `${name}|${server.id}`,
          { address: server.address, port: server.port });
        pool.markDead(server.id, !alive);
      }
    }
  }

  private sessionsTo(address: string, port: number): number {
    return this.getSessionTable().view().find(session =>
      session.translation?.translatedDest === address
      && session.translation?.translatedDestPort === port).length;
  }

  setRevisionOnLogout(enabled: boolean): void { this.revisionOnLogout = enabled; }

  revisionOnLogoutEnabled(): boolean { return this.revisionOnLogout; }

  bindConfigSnapshot(render: () => string): void { this.configSnapshot = render; }

  onAdminLogout(admin: string): void {
    if (!this.revisionOnLogout) return;
    const text = this.configSnapshot?.();
    if (text === undefined) return;
    this.revisions.record({
      admin,
      firmware: `v${this.profile.defaultVersion}`,
      comment: 'Automatic backup (logout)',
      text,
    });
  }

  getBridge(vdom?: string): BridgeFdb {
    return this.bridgeNamed(vdom ?? this.activeVdom);
  }

  bridgeNames(): readonly string[] {
    return Object.freeze(this.vdoms.names().map(name => `${name}.b`));
  }

  private watchBridgePort(port: Port): void {
    port.onLinkChange((state) => {
      if (state === 'up') return;
      const name = port.getName();
      for (const bridge of this.bridges.values()) bridge.forgetPort(name);
    });
  }

  private bridgeOf(iface: string): BridgeFdb {
    return this.bridgeNamed(this.vdoms.contextOfInterface(iface).name);
  }

  private bridgeNamed(vdom: string): BridgeFdb {
    const known = this.bridges.get(vdom);
    if (known) return known;
    const created = new BridgeFdb({ now: () => this.services.now() });
    this.bridges.set(vdom, created);
    return created;
  }

  private handleArpFrame(portName: string, packet: ARPPacket): void {
    if (!packet || packet.type !== 'arp') return;
    if (packet.operation === 'reply') { this.arp.handleReply(packet, portName); return; }
    if (!this.forwardsTransit()) return;
    const answer = this.arp.handleRequest(packet, portName);
    if (answer) this.emitArp(answer, portName);
  }

  private handleIpv4Frame(
    portName: string, packet: IPv4Packet, frame?: EthernetFrame,
  ): void {
    if (!packet || packet.type !== 'ipv4') return;
    if (ipv4HeaderProblem(packet)) return;

    const recolle = this.fragments.accept(packet, this.services.now(), portName);
    if (recolle === null) return;
    packet = recolle;

    const vdom = this.vdoms.contextOfInterface(portName);
    const decision = classifyIpv4(this.ingressHost(), portName, vdom, packet, frame);
    if (decision.kind === 'consumed') return;
    if (decision.kind === 'decapsulated') {
      this.handleIpv4Frame(decision.tunnel, decision.inner);
      return;
    }
    if (decision.kind === 'local') { this.deliverLocally(portName, packet); return; }

    if (this.deepInspection.owns(packet)) {
      this.deepInspection.resume(portName, packet);
      return;
    }

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
      if (context.verdict?.reason === 'ttl-expired') {
        this.sendTimeExceeded(portName, packet);
      }
      if (context.verdict?.reason === 'mtu-exceeded-df') {
        this.sendFragmentationNeeded(portName, packet, context.egressMtu);
      }
      return;
    }

    const forwarded = outcome.payload ?? context;
    if (this.interceptForDeepInspection(portName, packet, context)) return;
    if (forwarded.egressPort === undefined) return;
    this.forward(forwarded.egressPort, forwarded.packet as IPv4Packet,
      forwarded.policyRouteGateway,
      bridgedFrameOf(frame, forwarded.bridged === true
        || vdom.settings.opmode === 'transparent'));
  }

  private sendTimeExceeded(ingressPort: string, packet: IPv4Packet): void {
    this.sendIcmpError(ingressPort, packet, 'time-exceeded',
      ICMP_TTL_EXPIRED_IN_TRANSIT, {});
  }

  private sendIcmpError(
    ingressPort: string, packet: IPv4Packet,
    kind: 'time-exceeded' | 'destination-unreachable', code: number,
    options: { nextHopMTU?: number },
  ): void {
    if (!mayGenerateICMPError(packet)) return;

    const source = this.interfaces.get(ingressPort)?.ip;
    if (!source) return;

    const error = buildICMPError(
      new IPAddress(source), packet, kind, code, ICMP_ERROR_TTL, options);
    const route = this.getVdom().routes.resolveNextHop(packet.sourceIP.toString());
    this.forward(route?.iface ?? ingressPort, error, route?.nextHop);
  }

  private sendFragmentationNeeded(
    ingressPort: string, packet: IPv4Packet, nextHopMTU: number | undefined,
  ): void {
    this.sendIcmpError(ingressPort, packet, 'destination-unreachable',
      ICMP_UNREACH_FRAG_NEEDED, { nextHopMTU });
  }

  getDeepInspection(): SslDeepInspection { return this.deepInspection; }

  private interceptForDeepInspection(
    portName: string, packet: IPv4Packet, context: PacketContext,
  ): boolean {
    const rule = context.matchedPolicy;
    const name = rule?.sslSshProfile;
    if (!name) return false;
    const profile = this.getUtmProfiles().getSslSsh(name);
    if (!profile || profile.httpsMode !== 'deep-inspection') return false;

    return this.deepInspection.capture(portName, packet, {
      name: profile.name,
      ports: profile.httpsPorts,
      caName: profile.caName,
      untrustedCaName: profile.untrustedCaName ?? 'Fortinet_CA_Untrusted',
      serverCertMode: profile.serverCertMode ?? 're-sign',
      exemptions: (profile.exemptions ?? []).map(entry => ({
        type: entry.type,
        category: entry.category,
        regex: entry.regex,
        addressName: entry.addressName,
      })),
    });
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
        || this.sdwan.observeReply(p) || this.deliverToUdpSocket(p),
      answeredByDnsServer: (iface, p) => {
        if (p.protocol !== IP_PROTO_UDP) return false;
        const udp = p.payload as UDPPacket | undefined;
        return udp?.type === 'udp' && this.dnsServer.handleUdp(iface, p, udp);
      },
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

    for (const piece of this.fittingPieces(egressPort, packet)) {
      const frame = buildEgressFrame(
        this.egressDeps(), egressPort, piece, gateway, bridged);
      if (!frame) return;

      this.load.recordBytes('out', frameBytes(frame));
      this.capture.record({
        at: this.services.now(), iface: egressPort, direction: 'out', frame,
      });
      this.sendFrame(egressPort, frame);
    }
  }

  private fittingPieces(egressPort: string, packet: IPv4Packet): readonly IPv4Packet[] {
    const mtu = this.interfaces.get(egressPort)?.mtu;
    if (mtu === undefined || packet.totalLength <= mtu) return [packet];
    if ((packet.flags & IPV4_FLAG_DF) !== 0) return [packet];
    return fragmentIPv4(packet, mtu);
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
