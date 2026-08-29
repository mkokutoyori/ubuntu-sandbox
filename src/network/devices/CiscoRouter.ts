/**
 * CiscoRouter - Cisco IOS Router specialization
 *
 * Extends abstract Router with Cisco-specific:
 *   - Port naming: GigabitEthernet0/X
 *   - CLI shell: CiscoIOSShell
 *   - Boot sequence: Cisco IOS bootstrap
 */

import { Router } from './Router';
import type { Ipv4SendRequest } from '../layers/internet/Ipv4Egress';
import type { UdpSendRequest } from '../layers/transport/UdpEgress';
import { AgentRegistry } from './AgentRegistry';
import { cdpToNeighborDTO, lldpToNeighborDTO } from './inspection/neighborConverters';
import type { IRouterShell } from './shells/IRouterShell';
import { CiscoIOSShell } from './shells/CiscoIOSShell';
import {
  showVersion,
  showRunningConfig,
  showIpIntBrief,
} from './shells/cisco/CiscoShowCommands';
import { CdpAgent } from '../cdp/CdpAgent';
import { ETHERTYPE_CDP, CDP_MULTICAST_MAC } from '../cdp/types';
import { LldpAgent } from '../lldp/LldpAgent';
import { ETHERTYPE_LLDP, LLDP_MULTICAST_MAC } from '../lldp/types';
import { HsrpAgent } from '../hsrp/HsrpAgent';
import { UDP_PORT_HSRP } from '../hsrp/types';
import { VrrpAgent } from '../vrrp/VrrpAgent';
import { NtpAgent } from '../ntp/NtpAgent';
import { UDP_PORT_NTP } from '../ntp/types';
import { GlbpAgent } from '../glbp/GlbpAgent';
import { UDP_PORT_GLBP } from '../glbp/types';
import { BfdAgent } from '../bfd/BfdAgent';
import { UDP_PORT_BFD_CONTROL } from '../bfd/types';
import { IgmpAgent } from '../igmp/IgmpAgent';
import { PimAgent } from '../pim/PimAgent';
import { SyslogAgent } from '../syslog/SyslogAgent';
import { RadiusClientAgent } from '../radius/RadiusClientAgent';
import { RadiusServerAgent } from '../radius/RadiusServerAgent';
import { RadiusAccountingClient } from '../radius/RadiusAccountingClient';
import { CoaListener, type CoaSessionHandler } from '../radius/CoaListener';
import { CoaClient } from '../radius/CoaClient';
import { RadiusTcpClient, RadiusTcpServer } from '../radius/RadiusTcpTransport';
import { UDP_PORT_RADIUS_AUTH, UDP_PORT_RADIUS_ACCT, UDP_PORT_RADIUS_COA } from '../radius/types';
import { GreAgent } from '../gre/GreAgent';
import { SnmpAgent } from '../snmp/SnmpAgent';
import { v, vb } from '../snmp/types';
import { registerRttMonOperation } from '../snmp/mibs/RttMonMib';
import { UDP_PORT_SNMP } from '../snmp/types';
import { NetFlowAgent, type NetFlowRecordInput } from '../netflow/NetFlowAgent';
import { TacacsClientAgent } from '../tacacs/TacacsClientAgent';
import { TacacsServerAgent } from '../tacacs/TacacsServerAgent';
import { VxlanAgent } from '../vxlan/VxlanAgent';
import { UDP_PORT_VXLAN } from '../vxlan/types';
import { TcpStack } from '../tcp/TcpStack';
import type { EthernetFrame, IPv4Packet, UDPPacket } from '../core/types';
import type { IPAddress } from '../core/types';
import { IP_PROTO_TCP } from '../core/types';
import { dispatchControlPlaneIpv4 } from './router/controlPlaneIpv4';
import type { NeighborDTO } from './inspection/DeviceStateView';
import type { IEventBus } from '@/events/EventBus';
import { CertificateVerifier as CertificateVerifierImpl } from '../pki/CertificateVerifier';
import { TcpMssClamper as TcpMssClamperImpl } from '../ipsec/TcpMssClamper';
import { getSecurityConfig } from './shells/cisco/CiscoSecurityCommands';
import {
  algorithmesRetenus, chassisSerial, CISCO_HARDWARE_PROFILES, licenseTable,
  formatIosUptime,
} from './shells/cisco/CiscoCommonShow';

const CISCO_UDP_OWNERS: ReadonlyMap<number, string> = new Map([
  [UDP_PORT_HSRP, 'hsrp'],
  [UDP_PORT_NTP, 'ntp'],
  [UDP_PORT_GLBP, 'glbp'],
  [UDP_PORT_BFD_CONTROL, 'bfd'],
  [UDP_PORT_RADIUS_AUTH, 'radius'],
  [UDP_PORT_RADIUS_ACCT, 'radius-acct'],
  [UDP_PORT_RADIUS_COA, 'radius-coa'],
  [UDP_PORT_SNMP, 'snmp'],
  [UDP_PORT_VXLAN, 'vxlan'],
]);

export class CiscoRouter extends Router {
  protected bootsInterfacesShutdown(): boolean {
    return true;
  }

  /** Un ISR 2911 porte trois interfaces GigabitEthernet, pas quatre. */
  protected physicalPortCount(): number {
    return 3;
  }

  /**
   * IOS runs no SSH server without RSA host keys. `crypto key generate
   * rsa` is what actually brings SSH up, and `crypto key zeroize rsa`
   * takes it back down — the router's own version of deleting a Linux
   * host's `/etc/ssh/ssh_host_*_key` (docs/PRD-Pannes.md §F7.2).
   *
   * Read from the live key store rather than a separate flag, so the
   * config and the service can never disagree.
   */
  override hasSshHostKeys(): boolean {
    return getSecurityConfig(this).cryptoKeys.length > 0;
  }

  /**
   * The binding `ipv6 traffic-filter` wrote. It is read from the very
   * store the running-config renders, so a filter that shows in the
   * configuration is the filter the data plane applies.
   */
  protected override getIpv6TrafficFilter(iface: string): { name: string; direction: 'in' | 'out' } | null {
    return getSecurityConfig(this).ifaceFlags(iface).ipv6TrafficFilter ?? null;
  }

  installIkeCertAuth(config: {
    localCert: import('../pki/X509Certificate').X509Certificate;
    localKey: import('../pki/PkiKeyPair').PkiPrivateKey;
    trustAnchors: readonly import('../pki/X509Certificate').X509Certificate[];
    crls?: readonly import('../pki/CertificateRevocationList').CertificateRevocationList[];
    revocationCheck?: 'none' | 'crl' | 'crl-strict' | 'ocsp';
    clock?: () => number;
    ocspResponder?: import('../pki/OcspResponder').IOcspResponder;
  }): void {
    const verifier = new CertificateVerifierImpl({
      trustAnchors: config.trustAnchors,
      crls: config.crls,
      revocationCheck: config.revocationCheck ?? 'none',
      clock: config.clock,
      ocspResponder: config.ocspResponder,
    });
    this._getOrCreateIPSecEngine().setIkeCertAuth({
      localCert: config.localCert,
      localKey: config.localKey,
      trustAnchors: config.trustAnchors,
      crls: config.crls,
      revocationCheck: config.revocationCheck,
      clock: config.clock,
      verifier,
    });
  }

  clearIkeCertAuth(): void {
    this._getIPSecEngineInternal()?.clearIkeCertAuth();
  }

  getInterfaceTcpAdjustMss(iface: string): number | null {
    const port = this.getPort(iface);
    if (!port) return null;
    const v = (port as unknown as { tcpAdjustMss?: number }).tcpAdjustMss;
    return typeof v === 'number' ? v : null;
  }

  applyTcpMssClamp(
    seg: import('../ipsec/TcpMssClamper').TcpMssCarrier,
    iface: string,
  ): import('../ipsec/TcpMssClamper').TcpMssClampResult {
    const clamp = this.getInterfaceTcpAdjustMss(iface);
    if (clamp === null) {
      return { modified: false, before: null, after: null, reason: 'no-config' };
    }
    return TcpMssClamperImpl.clamp(seg, clamp);
  }

  private readonly cdpAgent: CdpAgent;
  private readonly lldpAgent: LldpAgent;
  private readonly hsrpAgent: HsrpAgent;
  private readonly agents = new AgentRegistry();
  private readonly vrrpAgent: VrrpAgent;
  private readonly ntpAgent: NtpAgent;
  private readonly glbpAgent: GlbpAgent;
  private readonly bfdAgent: BfdAgent;
  private readonly igmpAgent: IgmpAgent;
  private readonly pimAgent: PimAgent;
  private igmpPimUnsubs: Array<() => void> = [];
  private readonly syslogAgent: SyslogAgent;
  private readonly radiusClient: RadiusClientAgent;
  private readonly radiusServer: RadiusServerAgent;
  private readonly radiusAccountingClient: RadiusAccountingClient;
  private readonly coaListener: CoaListener;
  private readonly coaClient: CoaClient;
  private readonly radiusTcpClient: RadiusTcpClient;
  private readonly radiusTcpServer: RadiusTcpServer;
  private readonly greAgent: GreAgent;
  private readonly snmpAgent: SnmpAgent;
  private readonly netflowAgent: NetFlowAgent;
  private readonly tacacsClient: TacacsClientAgent;
  private readonly tacacsServer: TacacsServerAgent;
  private readonly vxlanAgent: VxlanAgent;
  constructor(name: string = 'Router', x: number = 0, y: number = 0) {
    super('router-cisco', name, x, y);
    const hostBase = {
      sendOnLink: (request: import('../layers/link/LinkLayer').LinkSendRequest) =>
        this.getLinkLayer().send(request),
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getType: () => this.getType(),
      getPort: (n: string) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
      resolveRoute: (ip: string) => this.resolveRouteForHost(ip),
      sendIpv4FrameArpAware: (p: string, ipPkt: IPv4Packet, nextHopIP: IPAddress) =>
        this.sendIpv4FrameArpAware(p, ipPkt, nextHopIP),
      sendIpv4Packet: (request: Ipv4SendRequest) => this.sendIpv4Packet(request),
      sendUdpDatagram: (request: UdpSendRequest) => this.sendUdpDatagram(request),
      sourceAddressFor: (destination: IPAddress) => this.sourceAddressFor(destination),
      sendArpRequestFor: (iface: string, target: IPAddress) =>
        this.sendArpRequestFor(iface, target),
      tcpConnect: (ip: string, port: number, opts: { onOpen?: () => void; onClose?: () => void }) =>
        this.getTcpStack().connect(ip, port, opts),
      evaluateAclPermit: (aclName: string, sourceIp: string) =>
        this.evaluateAclPermit(aclName, sourceIp),
    };
    this.cdpAgent = new CdpAgent(hostBase, () => this.getBus());
    this.lldpAgent = new LldpAgent(hostBase, () => this.getBus());
    this.hsrpAgent = new HsrpAgent(hostBase, () => this.getBus());
    this.vrrpAgent = new VrrpAgent(hostBase, () => this.getBus());
    this.ntpAgent = new NtpAgent(hostBase, () => this.getBus());
    // Un routeur repond a `ntpq` ; un poste sous chronyd non.
    this.ntpAgent.setModeControlResponder(true);
    // `ntp access-group` consulte les MEMES listes d'acces que le reste
    // du routeur (lot N6) : une seconde evaluation finirait par rendre
    // un verdict different pour la meme liste, sur la meme machine.
    this.ntpAgent.setAclMatchFn((acl, srcIp) => this.evaluateAclPermit(acl, srcIp));
    this.glbpAgent = new GlbpAgent(hostBase, () => this.getBus());
    this.bfdAgent = new BfdAgent(hostBase, () => this.getBus());
    this.getBus().subscribe('bfd.session.changed', (e) => {
      if (e.payload.deviceId !== this.id) return;
      if (e.payload.newState !== 'down' && e.payload.newState !== 'admin-down') return;
      this.ospfIntegration.onBfdSessionDown(e.payload.iface, e.payload.neighborIp);
    });
    this.igmpAgent = new IgmpAgent(hostBase, () => this.getBus());
    this.pimAgent = new PimAgent(hostBase, () => this.getBus());
    this.bindIgmpToPim();
    this.syslogAgent = new SyslogAgent(hostBase, () => this.getBus(),
      () => this.getRouterScheduler());
    this.radiusClient = new RadiusClientAgent(hostBase, () => this.getBus());
    this.radiusServer = new RadiusServerAgent(hostBase, () => this.getBus());
    this.radiusAccountingClient = new RadiusAccountingClient(hostBase, () => this.getBus());
    this.coaListener = new CoaListener(hostBase, () => this.getBus());
    this.coaListener.setSessionHandler(this.defaultCoaSessionHandler());
    this.coaClient = new CoaClient(hostBase, () => this.getBus());
    this.radiusTcpClient = new RadiusTcpClient(hostBase, () => this.getBus(), () => this.tcpv2);
    this.radiusTcpServer = new RadiusTcpServer(hostBase, () => this.getBus(), () => this.tcpv2);
    this.greAgent = new GreAgent(hostBase, () => this.getBus());
    this.snmpAgent = new SnmpAgent({
      ...hostBase,
      getSysDescr: () => `Cisco IOS Software, ${this.name}`,
      getSysObjectId: () => '1.3.6.1.4.1.9.1.222',
    }, () => this.getBus());
    this.netflowAgent = new NetFlowAgent(hostBase, () => this.getBus());
    this.tacacsClient = new TacacsClientAgent(hostBase, () => this.getBus(), () => this.tcpv2);
    this.tacacsServer = new TacacsServerAgent(hostBase, () => this.getBus(), () => this.tcpv2);
    this.vxlanAgent = new VxlanAgent(hostBase, () => this.getBus());
    this.agents.registerAll(
      this.cdpAgent, this.lldpAgent, this.hsrpAgent, this.vrrpAgent,
      this.ntpAgent, this.glbpAgent, this.bfdAgent, this.igmpAgent,
      this.pimAgent, this.syslogAgent, this.radiusClient, this.radiusServer,
      this.radiusAccountingClient, this.coaListener, this.coaClient,
      this.radiusTcpClient, this.radiusTcpServer,
      this.greAgent, this.snmpAgent, this.netflowAgent, this.tacacsClient,
      this.tacacsServer, this.vxlanAgent,
    );
    this.agents.startAll();
    this.getIpSlaEngine().setMibRegistrar((operationId) => {
      registerRttMonOperation(
        (oid, read) => this.snmpAgent.registerMib(oid, read),
        this.getIpSlaEngine(),
        operationId,
      );
    });
  }

  /**
   * RFC 5176 Disconnect-Request/CoA-Request act on whatever this NAS
   * actually tracks as a "session" — for a router that's its VTY/SSH lines.
   * Disconnect-Request really closes matching lines; CoA-Request just
   * checks one exists (no per-session attribute to mutate here yet).
   */
  private defaultCoaSessionHandler(): CoaSessionHandler {
    return {
      disconnect: (ids) => {
        if (!ids.username) return { ok: false, errorCause: 'missing-attribute' };
        const closed = this.getSshSessionRegistry().closeWhere(
          (s) => s.user === ids.username, 'radius-disconnect',
        );
        return closed > 0 ? { ok: true } : { ok: false, errorCause: 'session-context-not-found' };
      },
      reauthorize: (ids) => {
        if (!ids.username) return { ok: false, errorCause: 'missing-attribute' };
        const hasSession = this.getSshSessionRegistry().list().some((s) => s.user === ids.username && s.state !== 'closed');
        return hasSession ? { ok: true } : { ok: false, errorCause: 'session-context-not-found' };
      },
    };
  }

  override setEventBus(bus: IEventBus | null): void {
    super.setEventBus(bus);
    // Re-bind every agent's subscriptions to the newly injected bus.
    // (setEventBus can fire from the base constructor, before the registry
    // field initializer ran — hence the optional chain.)
    this.agents?.restartAll();
    this.bindIgmpToPim();
  }

  /**
   * IGMP membership → PIM outgoing-interface list. Held as an explicit
   * subscription pair so a bus swap re-establishes it, like `restartAll`
   * does for the agents themselves.
   */
  private bindIgmpToPim(): void {
    if (!this.pimAgent) return;
    for (const u of this.igmpPimUnsubs) u();
    const bus = this.getBus();
    this.igmpPimUnsubs = [
      bus.subscribe('igmp.group.joined', (e) => {
        if (e.payload.deviceId !== this.id) return;
        this.pimAgent.joinGroup(e.payload.groupAddress, e.payload.iface);
      }),
      bus.subscribe('igmp.group.left', (e) => {
        if (e.payload.deviceId !== this.id) return;
        this.pimAgent.leaveGroup(e.payload.groupAddress, e.payload.iface);
      }),
    ];
  }

  /**
   * Le trap IP SLA passe par l'agent SNMP de CETTE machine. `Router` ne
   * connaît pas d'agent SNMP (un routeur générique n'en a pas), d'où le
   * point d'extension surchargé ici plutôt qu'un accès direct.
   */
  protected override sendIpSlaTrap(
    oid: string,
    varBindings: Array<{ oid: string; kind: string; value: number | string }>,
  ): void {
    this.snmpAgent.sendTrap(oid, varBindings.map((binding) => vb(
      binding.oid,
      v(binding.kind === 'integer' ? 'integer' : 'gauge32', binding.value),
    )));
  }

  protected override isNtpSynchronized(): boolean {
    return this.ntpAgent.isSynced();
  }

  protected override controlPlaneUdpOwner(port: number): string | null {
    return CISCO_UDP_OWNERS.get(port) ?? super.controlPlaneUdpOwner(port);
  }

  protected override receiveControlPlaneUdp(
    inPort: string, ipPkt: IPv4Packet, udp: UDPPacket,
  ): boolean {
    if (udp.destinationPort === UDP_PORT_HSRP) {
      this.hsrpAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
      return true;
    }
    if (udp.destinationPort === UDP_PORT_NTP || udp.sourcePort === UDP_PORT_NTP) {
      this.ntpAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
      return true;
    }
    if (udp.destinationPort === UDP_PORT_GLBP) {
      this.glbpAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
      return true;
    }
    if (udp.destinationPort === UDP_PORT_BFD_CONTROL) {
      this.bfdAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
      return true;
    }
    if (udp.destinationPort === UDP_PORT_RADIUS_AUTH) {
      this.radiusServer.handleUdp(inPort, ipPkt.sourceIP, udp);
      return true;
    }
    if (udp.sourcePort === UDP_PORT_RADIUS_AUTH) {
      this.radiusClient.handleUdp(inPort, ipPkt.sourceIP, udp);
      return true;
    }
    if (udp.destinationPort === UDP_PORT_RADIUS_ACCT) {
      this.radiusServer.handleAcctUdp(inPort, ipPkt.sourceIP, udp);
      return true;
    }
    if (udp.sourcePort === UDP_PORT_RADIUS_ACCT) {
      this.radiusAccountingClient.handleUdp(inPort, ipPkt.sourceIP, udp);
      return true;
    }
    if (udp.destinationPort === UDP_PORT_RADIUS_COA) {
      this.coaListener.handleUdp(inPort, ipPkt.sourceIP, udp);
      return true;
    }
    if (udp.sourcePort === UDP_PORT_RADIUS_COA) {
      this.coaClient.handleUdp(inPort, ipPkt.sourceIP, udp);
      return true;
    }
    if (udp.destinationPort === UDP_PORT_SNMP || udp.sourcePort === UDP_PORT_SNMP) {
      this.snmpAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
      return true;
    }
    if (udp.destinationPort === UDP_PORT_VXLAN) {
      this.vxlanAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
      return true;
    }
    return false;
  }

  protected override receiveControlPlaneIpv4(inPort: string, ipPkt: IPv4Packet): boolean {
    return dispatchControlPlaneIpv4({
      igmp: this.igmpAgent,
      pim: this.pimAgent,
      vrrp: this.vrrpAgent,
      gre: this.greAgent,
      reinject: (port, inner) => this.processIPv4(port, inner, true),
    }, inPort, ipPkt);
  }

  protected override handleFrame(portName: string, frame: EthernetFrame): void {
    const dst = frame.dstMAC.toString().toLowerCase();
    if (frame.etherType === ETHERTYPE_CDP && dst === CDP_MULTICAST_MAC) {
      this.cdpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === ETHERTYPE_LLDP && dst === LLDP_MULTICAST_MAC) {
      this.lldpAgent.handleFrame(portName, frame);
      return;
    }
    super.handleFrame(portName, frame);
  }

  getCdpAgent(): CdpAgent { return this.cdpAgent; }
  getCdpNeighbors(): NeighborDTO[] { return cdpToNeighborDTO(this.cdpAgent.getNeighbors()); }
  getLldpAgent(): LldpAgent { return this.lldpAgent; }
  getLldpNeighbors(): NeighborDTO[] { return lldpToNeighborDTO(this.lldpAgent.getNeighbors()); }
  getHsrpAgent(): HsrpAgent { return this.hsrpAgent; }
  getVrrpAgent(): VrrpAgent { return this.vrrpAgent; }
  /** FHRP data plane: VIP ARP answering, virtual-MAC frame acceptance. */
  protected override fhrpDataPlanes() {
    return [this.hsrpAgent, this.vrrpAgent, this.glbpAgent];
  }
  getNtpAgent(): NtpAgent { return this.ntpAgent; }
  getGlbpAgent(): GlbpAgent { return this.glbpAgent; }
  getBfdAgent(): BfdAgent { return this.bfdAgent; }
  getIgmpAgent(): IgmpAgent { return this.igmpAgent; }
  getPimAgent(): PimAgent { return this.pimAgent; }
  getSyslogAgent(): SyslogAgent { return this.syslogAgent; }
  getRadiusClient(): RadiusClientAgent { return this.radiusClient; }
  getRadiusServer(): RadiusServerAgent { return this.radiusServer; }
  getRadiusAccountingClient(): RadiusAccountingClient { return this.radiusAccountingClient; }
  getCoaListener(): CoaListener { return this.coaListener; }
  getCoaClient(): CoaClient { return this.coaClient; }
  getRadiusTcpClient(): RadiusTcpClient { return this.radiusTcpClient; }
  getRadiusTcpServer(): RadiusTcpServer { return this.radiusTcpServer; }
  getGreAgent(): GreAgent { return this.greAgent; }
  getSnmpAgent(): SnmpAgent { return this.snmpAgent; }
  override getNetFlowAgent(): NetFlowAgent { return this.netflowAgent; }

  protected override recordNetflowSample(input: NetFlowRecordInput): void {
    this.netflowAgent.recordFlow(input);
  }
  getTacacsClient(): TacacsClientAgent { return this.tacacsClient; }
  getTacacsServer(): TacacsServerAgent { return this.tacacsServer; }
  getVxlanAgent(): VxlanAgent { return this.vxlanAgent; }

  protected getVendorPortName(index: number): string {
    return `GigabitEthernet0/${index}`;
  }

  protected sshVendorTag(): 'cisco' { return 'cisco'; }

  protected override sshNegotiatedAlgorithms(): { chiffrement: string; hmac: string } {
    return algorithmesRetenus(getSecurityConfig(this).ssh);
  }

  protected createShell(): IRouterShell {
    return new CiscoIOSShell();
  }

  /**
   * Vendor-identifying line shown to a non-interactive SSH client that
   * lands with no `banner motd` configured — mirrors the real prompt's
   * hostname so cross-vendor tooling (and the cross-vendor SSH test
   * suite) can tell which device family it reached. Suppressed when a
   * real `banner motd` IS configured (via `sshBanner()`, populated by
   * the `banner motd` command) so the two don't double up.
   */
  override getSshMotd(): string {
    if (this.sshBannerText) return '';
    return `Cisco IOS Software\n${this.hostname}#`;
  }

  /**
   * Synthetic SFTP-file source — Cisco IOS exposes running-config /
   * startup-config / flash:/ over scp when `ip scp server enable` is
   * set. The scp adapter calls read() with a path; we return the
   * canonical text the user would see via `show running-config`.
   */
  getSftpFileSource(): { read: (p: string) => string | null; list: () => readonly string[] } | null {
    if (!getSecurityConfig(this).ssh.scpServerEnabled) return null;
    const knownFiles = ['running-config', 'startup-config'];
    return {
      read: (path: string) => {
        const p = path.replace(/^\/+/, '').toLowerCase();
        if (p === 'running-config' || p === 'system:running-config') return showRunningConfig(this);
        if (p === 'startup-config' || p === 'nvram:startup-config') return showRunningConfig(this);
        return null;
      },
      list: () => knownFiles,
    };
  }

  override runSshCommandSync(
    _user: string,
    command: string,
  ): { output: string; exitCode: number } | null {
    // Le niveau du COMPTE qui s'est authentifie, ou celui que la ligne
    // vty impose. Sans lui, toute commande `show` passee par SSH
    // s'executait au niveau 15 quel que soit le compte.
    const niveauSsh = this._niveauPourCompte(_user);
    let trimmed = command.trim();
    if (!trimmed) return { output: '', exitCode: 0 };
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      trimmed = trimmed.slice(1, -1).trim();
    }

    // Expand `alias exec <head>` shortcuts before any pattern match so
    // `ssh ... "si"` invokes `show ip interface brief` via the dispatcher.
    const aliasHead = trimmed.split(/\s+/)[0];
    const shellAliases = (this as unknown as { shell?: { aliases?: { resolve: (m: string, n: string) => string | null } } }).shell?.aliases;
    const aliasExpansion = shellAliases?.resolve('exec', aliasHead) ?? null;
    const cmd = aliasExpansion
      ? aliasExpansion + trimmed.slice(aliasHead.length)
      : trimmed;

    // Universal connectivity probe used by every cross-vendor client.
    if (/^hostname\s*$/i.test(cmd)) {
      return { output: `${this.hostname}\n`, exitCode: 0 };
    }
    // `show version` — model + IOS banner.
    if (/^show\s+version\s*$/i.test(cmd)) {
      return { output: `${showVersion(this)}\n`, exitCode: 0 };
    }
    if (/^show\s+logging\s*$/i.test(cmd)) {
      const audit = this.getSecurityAuditLog();
      const formatted = audit.format();
      const header = 'Syslog logging: enabled (0 messages dropped, 0 flushes, 0 overruns, xml disabled, filtering disabled)\nConsole logging: level debugging, 0 messages logged, xml disabled\nMonitor logging: level debugging, 0 messages logged, xml disabled\nBuffer logging: level debugging, 0 messages logged, xml disabled\n\nLog Buffer (4096 bytes):\n';
      return { output: `${header}${formatted}\n`, exitCode: 0 };
    }
    if (/^show\s+privilege\s*$/i.test(cmd)) {
      return { output: 'Current privilege level is 15\n', exitCode: 0 };
    }
    if (/^show\s+users?\s*$/i.test(cmd)) {
      return { output: `${this.getSshSessionRegistry().formatShowUsers()}\n`, exitCode: 0 };
    }
    // `show ip interface brief`.
    if (/^show\s+ip\s+int(?:erface)?\s+brief\s*$/i.test(cmd)) {
      return { output: `${showIpIntBrief(this)}\n`, exitCode: 0 };
    }
    // `show running-config [ | include … ]` — pipe filter supported.
    // Ce raccourci contournait la porte des niveaux : il rendait la
    // configuration entiere quel que soit le compte, alors que
    // `show running-config` est une commande de niveau 15. La verdict
    // du niveau est demande AVANT de construire le texte, sinon on
    // aurait calcule ce qu'on refuse ensuite.
    const runMatch = /^show\s+run(?:ning-config)?(?:\s*\|\s*(include|exclude)\s+(.+))?$/i.exec(cmd);
    if (runMatch && niveauSsh < 15) {
      const refus = (this as unknown as {
        shell?: { runShowCommandSync?: (d: unknown, c: string, n?: number) => string };
      }).shell?.runShowCommandSync?.(this, 'show running-config', niveauSsh) ?? '';
      if (refus.includes('Invalid input')) return { output: `${refus}\n`, exitCode: 1 };
    }
    if (runMatch) {
      const base = showRunningConfig(this);
      const extra: string[] = this._listLocalUsers().map(u =>
        `username ${u.name} privilege ${u.privilege} secret 5 ${u.secret}`,
      );
      const blockCfg = this.getLoginBlockConfig();
      if (blockCfg) extra.push(`login block-for ${blockCfg.blockSeconds} attempts ${blockCfg.attempts} within ${blockCfg.withinSeconds}`);
      const full = extra.length > 0 ? `${base}\n${extra.join('\n')}` : base;
      if (!runMatch[1]) return { output: `${full}\n`, exitCode: 0 };
      // Real IOS `| include`/`| exclude` support basic regex alternation:
      // `include foo|bar` matches lines containing EITHER term.
      const alternatives = runMatch[2].trim().split('|').map(p => p.trim()).filter(p => p.length > 0);
      const matchesAny = (l: string): boolean => alternatives.some(alt => l.includes(alt));
      const lines = full.split('\n');
      const filtered = runMatch[1].toLowerCase() === 'include'
        ? lines.filter(matchesAny)
        : lines.filter(l => !matchesAny(l));
      return { output: `${filtered.join('\n')}\n`, exitCode: 0 };
    }
    if (/^show\s+\S/i.test(cmd)) {
      const shell = (this as unknown as {
        shell?: { runShowCommandSync?: (d: unknown, c: string, niveau?: number) => string };
      }).shell;
      let out: string | undefined;
      try {
        out = shell?.runShowCommandSync?.(this, cmd, niveauSsh);
      } catch {
        out = undefined;
      }
      if (out && !out.includes('Invalid input') && !out.includes('Incomplete command')) {
        return { output: `${out}\n`, exitCode: 0 };
      }
    }
    return null;
  }

  getBootSequence(): string {
    const ports = this._getPortsInternal();
    const giPorts = [...ports.keys()].filter(n => n.startsWith('Gig') && !n.includes('.'));
    const faPorts = [...ports.keys()].filter(n => n.startsWith('Fast'));
    const hw = CISCO_HARDWARE_PROFILES['router-isr2911'];
    return [
      '',
      'System Bootstrap, Version 15.0(1r)M15, RELEASE SOFTWARE (fc1)',
      'Copyright (c) 2003-2025 by cisco Systems, Inc.',
      '',
      `Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.7(3)M5, RELEASE SOFTWARE (fc1)`,
      'Technical Support: http://www.cisco.com/techsupport',
      `Copyright (c) 1986-2025 by Cisco Systems, Inc.`,
      '',
      `${this.hostname} uptime is ${formatIosUptime(this._getUptimeMs?.() ?? 0)}`,
      'System returned to ROM by power-on',
      'Last reload reason: power-on',
      '',
      '',
      'This product contains cryptographic features and is subject to United',
      'States and local country laws governing import, export, transfer and',
      'use. Delivery of Cisco cryptographic products does not imply',
      'third-party authority to import, export, distribute or use encryption.',
      '',
      '',
      ...licenseTable(),
      '',
      `Cisco ${hw.pid} (revision 1.0) with ${hw.dramKB}K/${hw.ioMemoryKB}K bytes of memory.`,
      `Processor board ID ${chassisSerial(hw, this.id)}`,
      `${giPorts.length} Gigabit Ethernet interfaces`,
      ...(faPorts.length > 0 ? [`${faPorts.length} FastEthernet interfaces`] : []),
      'DRAM configuration is 64 bits wide with parity enabled.',
      `${hw.nvramDisplayKB}K bytes of non-volatile configuration memory.`,
      `${Math.floor(hw.flashTotalBytes / 1024)}K bytes of ATA System CompactFlash 0 (Read/Write)`,
      '',
      `Base ethernet MAC address: ${ports.values().next().value?.getMAC().toCiscoString() ?? '0000.0000.0000'}`,
      // Le registre gouverne le demarrage : il est ANNONCE au demarrage
      // sur une vraie machine, et c'est la seule facon de voir qu'un
      // `config-register 0x2142` va faire ignorer la configuration au
      // prochain reload. Il manquait, alors que `show version` le rend —
      // et c'est le MEME rendu qui est lu, pas une seconde copie.
      this._getCiscoFileSystem('router-isr2911').renderConfigRegisterLine(),
      '',
      'Press RETURN to get started.',
    ].join('\n');
  }
}
