/**
 * HuaweiRouter - Huawei VRP Router specialization
 *
 * Extends abstract Router with Huawei-specific:
 *   - Port naming: GE0/0/X
 *   - CLI shell: HuaweiVRPShell
 *   - Boot sequence: Huawei VRP bootstrap
 */

import { Router } from './Router';
import { isMulticastIpv4 } from '../core/ip';
import { VRP_ACL_NUMBERING, VRP_SEQUENCING, VRP_DEFAULT_STEP } from './router/ACLEngine';
import { AgentRegistry } from './AgentRegistry';
import { lldpToNeighborDTO } from './inspection/neighborConverters';
import type { IRouterShell } from './shells/IRouterShell';
import { HuaweiVRPShell } from './shells/HuaweiVRPShell';
import {
  displayVersion,
  displayInterfaceBrief,
  displayCurrentConfig,
  displayIpIntBrief,
} from './shells/huawei/HuaweiDisplayCommands';
import { resolveHuaweiInterfaceName as resolveHuaweiIfName } from './shells/cli-utils';
import { LldpAgent } from '../lldp/LldpAgent';
import { ETHERTYPE_LLDP, LLDP_MULTICAST_MAC } from '../lldp/types';
import { VrrpAgent } from '../vrrp/VrrpAgent';
import { IP_PROTO_VRRP, VRRP_MULTICAST_MAC } from '../vrrp/types';
import { NtpAgent } from '../ntp/NtpAgent';
import { UDP_PORT_NTP } from '../ntp/types';
import { BfdAgent } from '../bfd/BfdAgent';
import { UDP_PORT_BFD_CONTROL } from '../bfd/types';
import { IgmpAgent } from '../igmp/IgmpAgent';
import { IP_PROTO_IGMP } from '../igmp/types';
import { PimAgent } from '../pim/PimAgent';
import { IP_PROTO_PIM, PIM_ALL_ROUTERS_MAC } from '../pim/types';
import { SyslogAgent } from '../syslog/SyslogAgent';
import { RadiusClientAgent } from '../radius/RadiusClientAgent';
import { RadiusServerAgent } from '../radius/RadiusServerAgent';
import { RadiusAccountingClient } from '../radius/RadiusAccountingClient';
import { CoaListener, type CoaSessionHandler } from '../radius/CoaListener';
import { CoaClient } from '../radius/CoaClient';
import { RadiusTcpClient, RadiusTcpServer } from '../radius/RadiusTcpTransport';
import { UDP_PORT_RADIUS_AUTH, UDP_PORT_RADIUS_ACCT, UDP_PORT_RADIUS_COA } from '../radius/types';
import { GreAgent } from '../gre/GreAgent';
import { IP_PROTO_GRE } from '../gre/types';
import { SnmpAgent } from '../snmp/SnmpAgent';
import { projectSnmpServiceOntoAgent } from '../snmp/snmpProjection';
import { UDP_PORT_SNMP } from '../snmp/types';
import { NetFlowAgent, type NetFlowRecordInput } from '../netflow/NetFlowAgent';
import { TacacsClientAgent } from '../tacacs/TacacsClientAgent';
import { TacacsServerAgent } from '../tacacs/TacacsServerAgent';
import { VxlanAgent } from '../vxlan/VxlanAgent';
import { UDP_PORT_VXLAN } from '../vxlan/types';
import { TcpStack } from '../tcp/TcpStack';
import type { EthernetFrame, IPv4Packet, UDPPacket, IPAddress } from '../core/types';
import { IP_PROTO_UDP, IP_PROTO_TCP } from '../core/types';
import type { NeighborDTO } from './inspection/DeviceStateView';
import type { IEventBus } from '@/events/EventBus';
import { HuaweiDebugService } from './router/diag/HuaweiDebugService';

export class HuaweiRouter extends Router {
  private readonly lldpAgent: LldpAgent;
  private readonly vrrpAgent: VrrpAgent;
  private readonly ntpAgent: NtpAgent;
  private readonly bfdAgent: BfdAgent;
  private readonly igmpAgent: IgmpAgent;
  private readonly pimAgent: PimAgent;
  private igmpPimUnsubs: Array<() => void> = [];
  private readonly syslogAgent: SyslogAgent;
  private readonly radiusClient: RadiusClientAgent;
  private readonly agents = new AgentRegistry();
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
    super('router-huawei', name, x, y);
    // VRP numérote autrement qu'IOS : 2000-2999 « basic », 3000-3999
    // « advanced ». Sans cette pose, le moteur appliquerait les plages
    // IOS, où 2000-2699 sont des listes ÉTENDUES.
    this._setAclNumberingPolicy(VRP_ACL_NUMBERING);
    // VRP numerote les regles par multiples du pas, en partant du pas (5).
    this._setAclSequencingPolicy(VRP_SEQUENCING, VRP_DEFAULT_STEP);
    // Et `traffic-filter` LAISSE PASSER un paquet qu'aucune regle
    // n'apparie, la ou IOS le refuse. Sans ce reglage, une ACL VRP ne
    // contenant qu'un `deny` bloquait tout le reste du trafic.
    this._setAclUnmatchedDataPlaneAction('permit');
    const hostBase = {
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getType: () => this.getType(),
      getPort: (n: string) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
      resolveMac: (ip: string) => this._getArpTableInternal().get(ip)?.mac ?? null,
      resolveRoute: (ip: string) => this.resolveRouteForHost(ip),
      sendIpv4FrameArpAware: (p: string, ipPkt: IPv4Packet, nextHopIP: IPAddress) =>
        this.sendIpv4FrameArpAware(p, ipPkt, nextHopIP),
      sendArpRequestFor: (iface: string, target: IPAddress) =>
        this.sendArpRequestFor(iface, target),
      tcpConnect: (ip: string, port: number, opts: { onOpen?: () => void; onClose?: () => void }) =>
        this.getTcpStack().connect(ip, port, opts),
      evaluateAclPermit: (aclName: string, sourceIp: string) =>
        this.evaluateAclPermit(aclName, sourceIp),
    };
    this.lldpAgent = new LldpAgent(hostBase, () => this.getBus());
    this.vrrpAgent = new VrrpAgent(hostBase, () => this.getBus());
    this.ntpAgent = new NtpAgent(hostBase, () => this.getBus());
    // Un routeur repond a `ntpq` ; un poste sous chronyd non.
    this.ntpAgent.setModeControlResponder(true);
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
      getSysDescr: () => `Huawei VRP, ${this.name}`,
      getSysObjectId: () => '1.3.6.1.4.1.2011.2.27',
    }, () => this.getBus());
    this.netflowAgent = new NetFlowAgent(hostBase, () => this.getBus());
    this.tacacsClient = new TacacsClientAgent(hostBase, () => this.getBus(), () => this.tcpv2);
    this.tacacsServer = new TacacsServerAgent(hostBase, () => this.getBus(), () => this.tcpv2);
    this.vxlanAgent = new VxlanAgent(hostBase, () => this.getBus());
    this.agents.registerAll(
      this.lldpAgent, this.vrrpAgent, this.ntpAgent, this.bfdAgent,
      this.igmpAgent, this.pimAgent, this.syslogAgent, this.radiusClient,
      this.radiusServer, this.radiusAccountingClient, this.coaListener, this.coaClient,
      this.radiusTcpClient, this.radiusTcpServer,
      this.greAgent, this.snmpAgent, this.netflowAgent,
      this.tacacsClient, this.tacacsServer, this.vxlanAgent,
    );
    this.agents.startAll();
    projectSnmpServiceOntoAgent(this.getSnmpService(), this.snmpAgent);
  }

  /** See CiscoRouter's identical helper — RFC 5176 CoA/Disconnect acting on this NAS's VTY/SSH sessions. */
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
    this._huaweiDebugService?.attachToBus(this.getBus(), this.id, this);
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

  private _huaweiDebugService: HuaweiDebugService | null = null;

  /**
   * Not named `getDebugService` (and not an `override` of `Router`'s
   * method): `Router.getDebugService()` is typed to return the
   * Cisco-flavoured `RouterDebugService`, and `HuaweiDebugService` has an
   * incompatible category type, so overriding it would violate Liskov
   * substitution. Huawei-side callers look this up by name via a cast
   * (see HuaweiOspfCommands.ts, HuaweiDisplayCommands.ts, HuaweiVRPShell.ts,
   * HuaweiTerminalSession.ts).
   */
  getHuaweiDebugService(): HuaweiDebugService {
    if (!this._huaweiDebugService) {
      this._huaweiDebugService = new HuaweiDebugService();
      this._huaweiDebugService.setPlatform('router');
      this._registerDebugSwitchboards(this._huaweiDebugService);
    }
    this._huaweiDebugService.attachToBus(this.getBus(), this.id, this);
    return this._huaweiDebugService;
  }

  /**
   * DHCP et IPSec tiennent legitimement leur propre drapeau : ils
   * s'annoncent au magasin unique plutot que d'etre recopies dedans, ce
   * qui donne une seule voix a `display debugging` et fait enfin porter
   * `undo debugging all` sur eux.
   */
  private _registerDebugSwitchboards(svc: HuaweiDebugService): void {
    svc.registerSwitchboard({
      lignes: () => {
        const d = this._getDHCPServerInternal().getDebugFlags();
        const out: string[] = [];
        if (d.serverPacket) out.push('DHCP server packet debugging is on');
        if (d.serverEvents) out.push('DHCP server event debugging is on');
        return out;
      },
      eteindre: () => {
        const dhcp = this._getDHCPServerInternal();
        dhcp.setDebugServerPacket(false);
        dhcp.setDebugServerEvents(false);
      },
    });
    svc.registerSwitchboard({
      lignes: () => {
        const eng = (this as unknown as {
          _getIPSecEngineInternal?: () => { isDebugEnabled?: (k: string) => boolean };
        })._getIPSecEngineInternal?.();
        if (!eng?.isDebugEnabled) return [];
        const out: string[] = [];
        if (eng.isDebugEnabled('isakmp')) out.push('IKE debugging is on');
        if (eng.isDebugEnabled('ipsec')) out.push('IPSec debugging is on');
        if (eng.isDebugEnabled('ikev2')) out.push('IKEv2 debugging is on');
        return out;
      },
      eteindre: () => {
        const eng = (this as unknown as {
          _getIPSecEngineInternal?: () => { setDebug?: (k: string, on: boolean) => void };
        })._getIPSecEngineInternal?.();
        for (const k of ['isakmp', 'ipsec', 'ikev2']) eng?.setDebug?.(k, false);
      },
    });
  }

  /**
   * A VRP session reads its `debugging` traces from the VRP registry —
   * the Cisco-flavoured one this device also inherits stays empty.
   */
  protected override getVtyDebugSource(): { subscribe(listener: (line: string) => void): () => void } {
    return this.getHuaweiDebugService();
  }

  /** VRP announces the incoming telnet login differently from IOS. */
  protected override getVtyAuthHeader(): string { return 'Login authentication'; }

  /**
   * VRP's counterpart of IOS's RSA host keys.
   *
   * `stelnet server enable` is not enough on its own: without a local key
   * pair there is nothing for the server to present, and VRP refuses. So
   * `rsa local-key-pair create` is what actually brings STelnet up and
   * `rsa local-key-pair destroy` takes it back down — the same fault, and
   * the same repair, as `crypto key generate`/`zeroize rsa` on the Cisco
   * side (docs/PRD-Pannes.md §F7.2). `display rsa local-key-pair public`
   * reads the same store, so the config and the service cannot disagree.
   */
  override hasSshHostKeys(): boolean {
    return this.getKeypairService().list().length > 0;
  }

  protected override processIPv4(inPort: string, ipPkt: IPv4Packet): void {
    if (ipPkt.protocol === IP_PROTO_IGMP) {
      this.igmpAgent.handleIp(inPort, ipPkt.sourceIP, ipPkt);
      return;
    }
    if (ipPkt.protocol === IP_PROTO_PIM) {
      this.pimAgent.handleIp(inPort, ipPkt.sourceIP, ipPkt);
      return;
    }
    if (ipPkt.protocol === IP_PROTO_GRE) {
      const inner = this.greAgent.handleIp(inPort, ipPkt.sourceIP, ipPkt);
      if (inner) this.processIPv4(inPort, inner);
      return;
    }
    if (ipPkt.protocol === IP_PROTO_UDP) {
      const udp = ipPkt.payload as UDPPacket | undefined;
      if (udp && udp.type === 'udp'
          && (udp.destinationPort === UDP_PORT_NTP || udp.sourcePort === UDP_PORT_NTP)) {
        this.ntpAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp' && udp.destinationPort === UDP_PORT_BFD_CONTROL) {
        this.bfdAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp' && udp.destinationPort === UDP_PORT_RADIUS_AUTH) {
        this.radiusServer.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp' && udp.sourcePort === UDP_PORT_RADIUS_AUTH) {
        this.radiusClient.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp' && udp.destinationPort === UDP_PORT_RADIUS_ACCT) {
        this.radiusServer.handleAcctUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp' && udp.sourcePort === UDP_PORT_RADIUS_ACCT) {
        this.radiusAccountingClient.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp' && udp.destinationPort === UDP_PORT_RADIUS_COA) {
        this.coaListener.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp' && udp.sourcePort === UDP_PORT_RADIUS_COA) {
        this.coaClient.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp'
          && (udp.destinationPort === UDP_PORT_SNMP || udp.sourcePort === UDP_PORT_SNMP)) {
        this.snmpAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
      if (udp && udp.type === 'udp' && udp.destinationPort === UDP_PORT_VXLAN) {
        this.vxlanAgent.handleUdp(inPort, ipPkt.sourceIP, udp);
        return;
      }
    }
    super.processIPv4(inPort, ipPkt);
  }

  protected override handleFrame(portName: string, frame: EthernetFrame): void {
    const dst = frame.dstMAC.toString().toLowerCase();
    if (frame.etherType === ETHERTYPE_LLDP && dst === LLDP_MULTICAST_MAC) {
      this.lldpAgent.handleFrame(portName, frame);
      return;
    }
    if (frame.etherType === 0x0800 && dst === VRRP_MULTICAST_MAC) {
      const ipPkt = frame.payload as IPv4Packet | undefined;
      if (ipPkt && ipPkt.protocol === IP_PROTO_VRRP) {
        this.vrrpAgent.handleIp(portName, ipPkt.sourceIP, ipPkt);
        return;
      }
    }
    if (frame.etherType === 0x0800
      && isMulticastIpv4(
        (frame.payload as IPv4Packet | undefined)?.destinationIP?.toString() ?? '')) {
      const ipPkt = frame.payload as IPv4Packet | undefined;
      if (ipPkt && ipPkt.protocol === IP_PROTO_IGMP) {
        this.igmpAgent.handleIp(portName, ipPkt.sourceIP, ipPkt);
        return;
      }
      if (ipPkt && ipPkt.protocol === IP_PROTO_PIM && dst === PIM_ALL_ROUTERS_MAC) {
        this.pimAgent.handleIp(portName, ipPkt.sourceIP, ipPkt);
        return;
      }
    }
    super.handleFrame(portName, frame);
  }

  getLldpAgent(): LldpAgent { return this.lldpAgent; }
  getLldpNeighbors(): NeighborDTO[] { return lldpToNeighborDTO(this.lldpAgent.getNeighbors()); }
  getVrrpAgent(): VrrpAgent { return this.vrrpAgent; }
  /** FHRP data plane: VIP ARP answering, virtual-MAC frame acceptance. */
  protected override fhrpDataPlanes() {
    return [this.vrrpAgent];
  }
  getNtpAgent(): NtpAgent { return this.ntpAgent; }
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
    return `GE0/0/${index}`;
  }

  protected sshVendorTag(): 'huawei' { return 'huawei'; }

  protected createShell(): IRouterShell {
    return new HuaweiVRPShell();
  }

  /** Synchronous VRP exec whitelist consumed by the SSH cross-platform dispatch. */
  override getSshMotd(): string {
    return `Huawei Versatile Routing Platform Software\n<${this.hostname}>`;
  }

  override runSshCommandSync(
    _user: string,
    command: string,
  ): { output: string; exitCode: number } | null {
    let cmd = command.trim();
    if (!cmd) return { output: '', exitCode: 0 };
    if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
      cmd = cmd.slice(1, -1).trim();
    }

    if (/^hostname\s*$/i.test(cmd)) {
      return { output: `${this.hostname}\n`, exitCode: 0 };
    }
    // Expand VRP `command-alias alias <head>` shortcuts before pattern
    // matching so `ssh ... "dis-int Gi0/0/0"` invokes display interface.
    const expanded = this._getCommandAliases().expand(cmd);
    if (expanded !== cmd) return this.runSshCommandSync(_user, expanded);
    if (/^display\s+version\s*$/i.test(cmd)) {
      return { output: `${displayVersion(this)}\n`, exitCode: 0 };
    }
    if (/^display\s+logbuffer\s*$/i.test(cmd)) {
      const audit = this.getSecurityAuditLog();
      const header = 'Logging buffer configuration and contents: enabled\nAllowed max buffer size : 1024\nActual buffer size : 1024\nChannel number : 4, Channel name : logbuffer\nDropped messages : 0\nOverwritten messages : 0\nCurrent messages : ' + audit.entries().length + '\n';
      return { output: `${header}${audit.format()}\n`, exitCode: 0 };
    }
    // Le chemin SSH synchrone ne traverse pas le trie : la commande est
    // interceptee ici comme ses voisines. Ce n'est PAS un second rendu —
    // les deux routes appellent le meme `formatDisplayUsers`.
    if (/^display\s+users\s*$/i.test(cmd)) {
      return { output: `${this.getSshSessionRegistry().formatDisplayUsers()}\n`, exitCode: 0 };
    }
    if (/^display\s+ssh\s+server\s+session\s*$/i.test(cmd)) {
      const header = 'Conn   Ver  Idle    User       IP';
      const sessions = this.getSshSessionRegistry().list();
      const rows = sessions.length === 0
        ? [`(none) 2    --      --         --`]
        : sessions.map((s, i) => {
          const h = Math.floor(s.idleSeconds / 3600).toString().padStart(2, '0');
          const m = Math.floor((s.idleSeconds % 3600) / 60).toString().padStart(2, '0');
          const sec = Math.floor(s.idleSeconds % 60).toString().padStart(2, '0');
          return `${(i + 1).toString().padEnd(6)} 2    ${h}:${m}:${sec}  ${s.user.padEnd(10)} ${s.fromIp}`;
        });
      return { output: `${[header, ...rows].join('\n')}\n`, exitCode: 0 };
    }
    if (/^display\s+local-user\s*$/i.test(cmd)) {
      const users = this._listLocalUsers();
      return { output: `User-name              State   Type   Privilege\n${users.map(u => `${u.name.padEnd(22)} A       SSH    ${u.privilege}`).join('\n')}\n`, exitCode: 0 };
    }
    if (/^display\s+int(?:erface)?\s+brief\s*$/i.test(cmd)) {
      return { output: `${displayInterfaceBrief(this)}\n`, exitCode: 0 };
    }
    // `display interface <name>` — per-interface details (matches the
    // VRP convention used after the command-alias expansion above).
    const dispInt = /^display\s+int(?:erface)?\s+(\S+)\s*$/i.exec(cmd);
    if (dispInt) {
      const portName = resolveHuaweiIfName(Array.from(this._getPortsInternal().keys()), dispInt[1]) || dispInt[1];
      const port = this.getPort(portName);
      if (!port) {
        return { output: `Error: Wrong parameter found at '^' position.\n`, exitCode: 1 };
      }
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      const lines = [
        `${dispInt[1]} current state : ${port.getIsUp() ? 'UP' : 'DOWN'}`,
        `Line protocol current state : ${port.getIsUp() ? 'UP' : 'DOWN'}`,
        `Description:`,
        `Switch Port, Link-type : auto negotiation,`,
        `Hardware address is ${port.getMAC()}`,
        ip && mask ? `Internet Address is ${ip}/${mask}` : 'Internet protocol processing : disabled',
      ];
      return { output: `${lines.join('\n')}\n`, exitCode: 0 };
    }
    if (/^display\s+ip\s+int(?:erface)?\s+brief\s*$/i.test(cmd)) {
      return { output: `${displayIpIntBrief(this)}\n`, exitCode: 0 };
    }
    // `display current-configuration [ | include … ]` — synthesises a
    // VRP-style running config with the SSH-relevant directives that
    // were captured by the shell hooks.
    const dispMatch = /^display\s+current-configuration(?:\s*\|\s*(include|exclude)\s+(.+))?$/i.exec(cmd);
    if (dispMatch) {
      const base = displayCurrentConfig(this, false, false);
      const lines = base.split('\n');
      for (const u of this._listLocalUsers()) {
        lines.push(`local-user ${u.name} password cipher ${u.secret}`);
        lines.push(`local-user ${u.name} privilege level ${u.privilege}`);
      }
      const retries = this.getSshAuthenticationRetries();
      if (retries !== null) lines.push(`ssh server authentication-retries ${retries}`);
      // Append SSH-state directives so SSH-aware tests see them. Real
      // VRP emits "protocol inbound ssh" specifically when ssh is among
      // the permitted protocols (not just when 'all' is set), so the
      // grep-style assertions in operations notebooks keep working.
      if (this.sshServerEnabled) lines.push('stelnet server enable');
      const admis = this._getVtyTransportInput();
      if (admis === 'all' || admis === 'ssh') {
        lines.push('protocol inbound ssh');
      } else if (admis === 'telnet') {
        lines.push('protocol inbound telnet');
      } else {
        lines.push('protocol inbound none');
      }
      const out = lines.join('\n');
      if (!dispMatch[1]) return { output: `${out}\n`, exitCode: 0 };
      const needle = dispMatch[2].trim();
      const filtered = dispMatch[1].toLowerCase() === 'include'
        ? lines.filter(l => l.includes(needle))
        : lines.filter(l => !l.includes(needle));
      return { output: `${filtered.join('\n')}\n`, exitCode: 0 };
    }
    return null;
  }

  getBootSequence(): string {
    const ports = this._getPortsInternal();
    return [
      '',
      'Huawei Versatile Routing Platform Software',
      'VRP (R) software, Version 5.170 (AR2220 V200R009C00SPC500)',
      'Copyright (C) 2000-2025 HUAWEI TECH CO., LTD',
      '',
      'BOARD TYPE:          AR2220',
      'BootROM Version:     1.0',
      '',
      `${ports.size} GigabitEthernet interfaces`,
      '',
      `Base ethernet MAC address: ${ports.values().next().value?.getMAC() || '00:00:00:00:00:00'}`,
      '',
      'Press any key to get started.',
    ].join('\n');
  }
}
