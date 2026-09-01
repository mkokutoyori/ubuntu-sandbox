/**
 * Switch - Abstract Layer 2 switching device base class
 *
 * Implements common L2 switching logic shared by all vendors:
 *   - VLAN database (802.1Q tagging)
 *   - MAC address table with configurable aging (default 300s)
 *   - Access / Trunk port modes
 *   - Native VLAN on trunk links
 *   - Trunk allowed VLAN filtering
 *   - Running-config / Startup-config (NVRAM simulation)
 *
 * Vendor-specific behavior (overridden by subclasses):
 *   - Port naming: Cisco (FastEthernet0/X) vs Huawei (GigabitEthernet0/0/X)
 *   - STP initial state: Cisco (forwarding/PortFast) vs Huawei (listening/802.1D)
 *   - VLAN deletion: Cisco (suspend ports) vs Huawei (move to default VLAN)
 *   - CLI Shell: CiscoSwitchShell vs HuaweiSwitchShell (in shells/ directory)
 *   - Boot sequence and OS type
 *
 * Concrete subclasses: CiscoSwitch, HuaweiSwitch
 *
 * Frame processing pipeline:
 *   1. Ingress: determine VLAN from port mode (access VLAN or 802.1Q tag)
 *   2. MAC learning: associate srcMAC + VLAN → ingress port
 *   3. Forward decision:
 *      a. Broadcast/unknown unicast → flood within VLAN
 *      b. Known unicast → forward to specific port (if same VLAN)
 *   4. Egress: strip or add 802.1Q tag based on egress port mode
 */

import { Equipment } from '../equipment/Equipment';
import {
  CarPolicer, suppressionKindOf, cloneCarRule,
  type SuppressionKind, type CarRule,
} from '../qos/CarPolicer';
import { CiscoFileSystem } from './shells/cisco/CiscoFileSystem';
import { Port } from '../hardware/Port';
import { CliShellSession } from './shells/vty/CliShellSession';
import { getSessionRegistry } from '../equipment/RouterServiceCapabilities';
import { EthernetFrame, DeviceType, MACAddress, ETHERTYPE_ARP, ARPPacket, IPAddress, SubnetMask, ETHERTYPE_IPV4, IPv4Packet,
  ethernetFrameBytes,
} from '../core/types';
import { DHCPPacket } from '../dhcp/DHCPPacket';
import { VlanSet } from './switch/VlanSet';
import { RouterDhcpClient } from './router/RouterDhcpClient';
import { SwitchSvi, type SviInterface } from './SwitchSvi';
import { ControlPlaneUdpEndpoint } from './udp/ControlPlaneUdpEndpoint';
import {
  requiresNamedInterface, sendOnNamedInterface, type Ipv4SendRequest,
} from '../layers/internet/Ipv4Egress';
import { getSecurityConfig } from './shells/cisco/CiscoSecurityCommands';
import { AaaAuthenticator } from './router/aaa/AaaAuthenticator';
import { isInteractionPlanner } from '@/shell/interaction/CommandInteraction';
import {
  hasHeadlessAnswers, runInteractionPlanHeadless, type HeadlessAnswers,
} from '@/shell/interaction/HeadlessInteraction';
import { DHCPServer } from '../dhcp/DHCPServer';
import { VrrpAgent } from '../vrrp/VrrpAgent';
import { IP_PROTO_VRRP } from '../vrrp/types';
import { HsrpAgent } from '../hsrp/HsrpAgent';
import { UDP_PORT_HSRP } from '../hsrp/types';
import { GlbpAgent } from '../glbp/GlbpAgent';
import { UDP_PORT_GLBP } from '../glbp/types';
import { IP_PROTO_UDP, createIPv4Packet } from '../core/types';
import type { ARPEntry } from '../core/types';
import type { UDPPacket } from '../core/types';
import { makeSwitchVrrpHost, makeSwitchNtpHost } from './switch/SwitchVrrpAdapter';
import { NtpAgent } from '../ntp/NtpAgent';
import { UDP_PORT_NTP } from '../ntp/types';
import type { CiscoPingRow } from './shells/cisco/ciscoPing';
import { Logger } from '../core/Logger';
import { isGroupAddress } from '../layers/link/LinkLayer';
import {
  getDefaultScheduler,
  type IScheduler,
  type TimerHandle,
} from '@/events/Scheduler';
import {
  DHCPSnoopingConfig,
  DHCPSnoopingBinding,
  createDefaultSnoopingConfig,
} from '../dhcp/types';
import {
  type ArpAccessList,
  type ArpInspectionConfig,
  createDefaultArpInspectionConfig,
} from '../arp/types';
import { ArpInspectionPipeline } from '../arp/ArpInspectionPipeline';
import { ArpRateLimiter } from '../arp/ArpRateLimiter';
import { ArpStats } from '../arp/ArpStats';
import type { ISwitchShell } from './shells/ISwitchShell';
import { SwitchSecurityService } from './switch/SwitchSecurityService';
import { CiscoHttpService } from './router/management/CiscoHttpService';
import { PortMirror, type MirrorDirection, type MirrorSession } from './switch/PortMirror';
import { ACLEngine } from './router/ACLEngine';
import { NetworkOsCredentialStore } from './router/aaa/NetworkOsCredentialStore';
import { SshSessionRegistry } from './router/aaa/SshSessionRegistry';
import { RouterSshKnownHosts } from './router/ssh/RouterSshKnownHosts';
import { CiscoDnsConfig } from './router/dns/CiscoDnsConfig';
import { RouterHostsTable } from './router/dns/RouterHostsTable';
import { NetworkOsAccount, applyCiscoUsernamePatch } from './router/aaa/NetworkOsAccount';
import type { CiscoUsernamePatch, PasswordHashAlgorithm } from './router/aaa/NetworkOsAccount';
import { VtyLineConfigStore } from './router/vty/VtyLineConfigStore';
import { classifyIpv4Destination } from '../layers/internet/InternetLayer';

// Re-export shell classes for backward compatibility
export { CiscoSwitchShell } from './shells/CiscoSwitchShell';
export type { CLIMode } from './shells/CiscoSwitchShell';
export { HuaweiSwitchShell as HuaweiVRPSwitchShell } from './shells/HuaweiSwitchShell';

// ─── 802.1Q Tag ─────────────────────────────────────────────────────

export interface Dot1QTag {
  tpid: number;   // 0x8100
  pcp: number;    // Priority Code Point (0-7)
  dei: number;    // Drop Eligible Indicator
  vid: number;    // VLAN ID (1-4094)
}

// ─── Extended Ethernet Frame (with optional VLAN tag) ───────────────

export interface TaggedEthernetFrame extends EthernetFrame {
  dot1q?: Dot1QTag;
  /** Outer S-VLAN tag (802.1ad QinQ, EtherType 0x88a8) pushed by a dot1q-tunnel port; `dot1q`, if present, is the untouched customer C-VLAN tag underneath it. */
  outerDot1q?: Dot1QTag;
}

// ─── Port Configuration ─────────────────────────────────────────────

export type SwitchportMode = 'access' | 'trunk' | 'hybrid' | 'dot1q-tunnel';

export interface SwitchportConfig {
  mode: SwitchportMode;
  explicitMode: boolean;
  accessVlan: number;           // VLAN for access mode (default 1)
  trunkNativeVlan: number;      // Native VLAN for trunk mode (default 1)
  trunkAllowedVlans: VlanSet;
  voiceVlan?: number;             // Voice VLAN (switchport voice vlan N)
  voiceVlanAutoOui?: boolean;
  hybridPvid?: number;
  hybridUntaggedVlans?: Set<number>;
  hybridTaggedVlans?: Set<number>;
  /** 802.1p trust boundary for this port (Cisco `mls qos trust`, Huawei `qos trust`). */
  trustMode?: 'cos' | 'dscp' | 'untrusted';
  /** Default CoS applied to untrusted/untagged ingress traffic (Cisco `mls qos cos`, Huawei `port priority`). */
  defaultCos?: number;
  /** Voice-VLAN port priority-extend behaviour (Cisco `switchport priority extend`, Huawei `trust upstream`). */
  priorityExtend?: { mode: 'cos'; value: number } | { mode: 'trust' };
  /**
   * Selective QinQ / VLAN mapping on a dot1q-tunnel port (Cisco `switchport
   * vlan mapping <cvlan> <svlan>`, Huawei `port vlan-mapping vlan <cvlan>
   * map-vlan <svlan>`): client VLAN -> service (S-VLAN) translation, chosen
   * per ingress C-VLAN instead of the port's single `accessVlan`. Several
   * C-VLANs may map to the same S-VLAN (N:1 aggregation).
   */
  vlanMapping?: Map<number, number>;
  /**
   * L2 protocol tunneling on a dot1q-tunnel port (Cisco `l2protocol-tunnel
   * {cdp|stp|vtp|lldp}`, Huawei `bpdu-tunnel {stp|lldp} enable`): control
   * frames for the listed protocols are never handed to this switch's own
   * agent — they're relayed as opaque data across the S-VLAN so two client
   * switches see each other's protocol traffic through a transparent
   * provider, instead of the provider terminating/originating it locally.
   */
  l2ptProtocols?: Set<'cdp' | 'stp' | 'vtp' | 'lldp'>;
}

// ─── IGMP snooping seam ─────────────────────────────────────────────

/**
 * Minimal surface the base Switch needs from a vendor's IGMP-snooping
 * agent (Interface Segregation: the base never sees the full agent).
 */
export interface IgmpSnoopingAgentLike {
  getVlanState(vlan: number): { enabled: boolean } | undefined;
  computeEgressPorts(ingressPort: string, groupAddress: string): string[];
}

/** Same shape as the IGMP one, plus the global on/off PIM snooping has. */
export interface PimSnoopingAgentLike extends IgmpSnoopingAgentLike {
  getConfig(): { enabled: boolean };
}

export interface VtpPruningAgentLike {
  isVlanPruned(portName: string, vlan: number): boolean;
}

// ─── Private VLAN (PVLAN) ────────────────────────────────────────────

export type PrivateVlanRole = 'primary' | 'isolated' | 'community';

export interface PrivateVlanPortConfig {
  role: 'host' | 'promiscuous';
  hostKind?: 'isolated' | 'community';
  primaryVlan: number;
  secondaryVlan?: number;
  mappedSecondaryVlans?: Set<number>;
}

// ─── VLAN Access Map (Cisco VACL) ───────────────────────────────────

export interface VlanAccessMapRule {
  sequence: number;
  matchIpAcl?: string;
  action: 'forward' | 'drop';
}

// ─── MQC (Huawei traffic classifier/behavior/policy) ────────────────

export interface MqcPolicyBinding {
  classifier: string;
  behavior: string;
}

export interface MqcCounters {
  matchedPackets: number;
  matchedBytes: number;
  passedPackets: number;
  passedBytes: number;
  droppedPackets: number;
  droppedBytes: number;
}

export function emptyMqcCounters(): MqcCounters {
  return {
    matchedPackets: 0, matchedBytes: 0,
    passedPackets: 0, passedBytes: 0,
    droppedPackets: 0, droppedBytes: 0,
  };
}

export interface MqcRemark {
  dscp?: number;
  dot1p?: number;
}

export function mqcRemarkLines(remark: MqcRemark): string[] {
  const lines: string[] = [];
  if (remark.dscp !== undefined) lines.push(`remark dscp ${remark.dscp}`);
  if (remark.dot1p !== undefined) lines.push(`remark 8021p ${remark.dot1p}`);
  return lines;
}

export type MqcMatch =
  | { kind: 'acl'; ref: string }
  | { kind: 'vlan-id'; vlan: number }
  | { kind: 'any' };

export function mqcMatchLine(match: MqcMatch): string {
  switch (match.kind) {
    case 'acl': return `if-match acl ${match.ref}`;
    case 'vlan-id': return `if-match vlan-id ${match.vlan}`;
    case 'any': return 'if-match any';
  }
}

// ─── MAC Table Entry ────────────────────────────────────────────────

export type MacLearningAction = 'discard' | 'forward';

export interface MACTableEntry {
  mac: string;
  vlan: number;
  port: string;
  type: 'static' | 'dynamic' | 'blackhole';
  age: number;           // seconds remaining before expiry
  timestamp: number;     // last refresh time
}

// ─── VLAN Entry ─────────────────────────────────────────────────────

export interface VLANEntry {
  id: number;
  name: string;
  ports: Set<string>;  // ports assigned to this VLAN
}

// ─── STP Port State ─────────────────────────────────────────────────

export type STPPortState = 'blocking' | 'listening' | 'learning' | 'forwarding' | 'disabled';

// ─── Switch Class (Abstract Base) ───────────────────────────────────

export abstract class Switch extends Equipment {
  private _securityService: SwitchSecurityService | null = null;
  getSecurityService(): SwitchSecurityService {
    if (!this._securityService) this._securityService = new SwitchSecurityService();
    return this._securityService;
  }

  /**
   * Un Catalyst connaît `ip http server` — c'est même la commande que
   * tout guide de durcissement fait désactiver en premier. Le magasin est
   * donc le MÊME que celui du routeur, pour que les deux plateformes ne
   * puissent pas décrire différemment la même configuration.
   *
   * Limite assumée et écrite plutôt que tue : ce commutateur-ci n'a AUCUNE
   * pile TCP (pas de `tcpv2`, donc pas davantage de serveur SSH), si bien
   * que la configuration est gardée et rendue mais qu'aucun port ne
   * s'ouvre. C'est déjà ce qui vaut pour tout serveur sur un commutateur
   * ici, et c'est strictement mieux qu'avant, où la commande était rangée
   * dans une table sans rendu et disparaissait à l'enregistrement.
   */
  private _httpService: CiscoHttpService | null = null;
  getHttpService(): CiscoHttpService {
    if (!this._httpService) this._httpService = new CiscoHttpService();
    return this._httpService;
  }

  private macTable: Map<string, MACTableEntry> = new Map(); // key: "vlan:mac"
  private macLearningPorts = new Map<string, MacLearningAction>();
  private macLearningVlans = new Map<number, MacLearningAction>();
  private macAgingTime: number = 300; // seconds
  /**
   * STP topology-change fast aging (802.1D-1998 §8.3.5): while set,
   * dynamic entries age with this value (forward delay) instead of
   * `macAgingTime`, so stale paths flush quickly after a reconvergence.
   */
  private stpFastAgingTime: number | null = null;
  private macAgingTimer: TimerHandle | null = null;
  private macAgingScheduler: IScheduler | null = null;
  private schedulerOverride: IScheduler | null = null;

  // ─── VLAN Database ──────────────────────────────────────────────
  protected vlans: Map<number, VLANEntry> = new Map();

  // ─── Port Configurations ────────────────────────────────────────
  private switchportConfigs: Map<string, SwitchportConfig> = new Map();

  private readonly carPolicers = new Map<string, CarPolicer>();

  private readonly suppressionPolicers = new Map<string, Map<SuppressionKind, CarPolicer>>();

  getCarPolicer(ifName: string, create = false): CarPolicer | undefined {
    let policer = this.carPolicers.get(ifName);
    if (!policer && create) {
      policer = new CarPolicer();
      this.carPolicers.set(ifName, policer);
    }
    return policer;
  }

  getSuppressionPolicer(
    ifName: string, kind: SuppressionKind, create = false,
  ): CarPolicer | undefined {
    let perPort = this.suppressionPolicers.get(ifName);
    if (!perPort && create) {
      perPort = new Map();
      this.suppressionPolicers.set(ifName, perPort);
    }
    if (!perPort) return undefined;
    let policer = perPort.get(kind);
    if (!policer && create) {
      policer = new CarPolicer();
      perPort.set(kind, policer);
    }
    return policer;
  }

  clearSuppression(ifName: string, kind: SuppressionKind): void {
    this.suppressionPolicers.get(ifName)?.get(kind)?.clear();
  }

  private policeIngress(portName: string, frame: EthernetFrame): boolean {
    const bytes = ethernetFrameBytes(frame);

    const kind = suppressionKindOf(frame.dstMAC.toString());
    const suppression = this.suppressionPolicers.get(portName)?.get(kind);
    if (suppression && !suppression.isEmpty() && !suppression.police('input', bytes)) {
      Logger.debug(this.id, 'switch:suppression-drop',
        `${this.name}: ${kind}-suppression dropped a frame on ${portName}`);
      return false;
    }

    const car = this.carPolicers.get(portName);
    if (car && !car.isEmpty() && !car.police('input', bytes)) {
      Logger.debug(this.id, 'switch:car-drop',
        `${this.name}: qos car dropped a frame on ${portName}`);
      return false;
    }
    return true;
  }

  // ─── Private VLAN (PVLAN) ────────────────────────────────────────
  private pvlanRoles: Map<number, PrivateVlanRole> = new Map();
  private pvlanAssociations: Map<number, Set<number>> = new Map();
  private pvlanSecondaryToPrimary: Map<number, number> = new Map();
  private pvlanPorts: Map<string, PrivateVlanPortConfig> = new Map();
  private pvlanSviMappings: Map<number, Set<number>> = new Map();

  // ─── Port isolation (Huawei port-isolate) ──────────────────────
  private portIsolateGroups: Map<string, number> = new Map();
  private protectedPorts: Set<string> = new Set();

  // ─── Super-VLAN / Sub-VLAN (Huawei) ────────────────────────────
  private superVlanIds: Set<number> = new Set();
  private superVlanSubVlans: Map<number, Set<number>> = new Map();
  private subVlanToSuperVlan: Map<number, number> = new Map();

  // ─── VLAN Access Map (Cisco VACL) ──────────────────────────────
  private vaclEngine: ACLEngine | null = null;
  private vlanAccessMaps: Map<string, VlanAccessMapRule[]> = new Map();
  private vlanFilterBindings: Map<number, string> = new Map();

  // ─── MQC (Huawei) ──────────────────────────────────────────────
  private mqcClassifiers: Map<string, MqcMatch[]> = new Map();
  private mqcBehaviors: Map<string, 'permit' | 'deny'> = new Map();
  private mqcBehaviorCar: Map<string, CarRule> = new Map();
  private mqcBehaviorRemark: Map<string, MqcRemark> = new Map();
  private mqcBehaviorStatistic: Set<string> = new Set();
  private mqcCounters: Map<string, MqcCounters> = new Map();
  private mqcCarBuckets: Map<string, { raw: string; policer: CarPolicer }> = new Map();
  private mqcPolicies: Map<string, MqcPolicyBinding[]> = new Map();
  private vlanTrafficPolicies: Map<number, string> = new Map();
  private portTrafficPolicies: Map<string, string> = new Map();

  // ─── STP Port States ────────────────────────────────────────────
  private stpStates: Map<string, STPPortState> = new Map();
  private stpVlanStates: Map<string, STPPortState> = new Map();

  // ─── MAC Move Detection ───────────────────────────────────────
  private macMoveCount: number = 0;

  // ─── Port VLAN State (active/suspended) ────────────────────────
  protected portVlanStates: Map<string, 'active' | 'suspended'> = new Map();

  private readonly portMirror = new PortMirror();
  private mirrorReentrant = false;

  getPortMirror(): PortMirror { return this.portMirror; }

  private readonly _unhandledConfigLines: string[] = [];
  getUnhandledConfigLines(): readonly string[] { return [...this._unhandledConfigLines]; }
  _recordUnhandledConfigLine(line: string): void {
    if (this._unhandledConfigLines.length < 1024) this._unhandledConfigLines.push(line);
  }
  _removeUnhandledConfigLine(needle: string): void {
    const idx = this._unhandledConfigLines.findIndex(l => l === needle || l.startsWith(needle));
    if (idx >= 0) this._unhandledConfigLines.splice(idx, 1);
  }

  // ─── Config Persistence ─────────────────────────────────────────
  private startupConfig: string | null = null;
  protected readonly initialHostname: string;

  // ─── DHCP Snooping ────────────────────────────────────────────
  private dhcpSnooping: DHCPSnoopingConfig = createDefaultSnoopingConfig();
  private snoopingBindings: DHCPSnoopingBinding[] = [];
  private snoopingLog: string[] = [];
  private dhcpSnoopingViolations = 0;
  private dhcpSnoopingForwarded = 0;
  private dhcpSnoopingDroppedUntrusted = 0;
  private dhcpSnoopingDroppedRateLimit = 0;
  private dhcpSnoopingDroppedVerifyMac = 0;
  private readonly dhcpSnoopingRateLimiter = new ArpRateLimiter();

  // ─── Interface Descriptions ──────────────────────────────────────
  private interfaceDescriptions: Map<string, string> = new Map();

  // ─── Management ARP Table ──────────────────────────────────────
  private arpTable: Map<string, ARPEntry> = new Map();
  private readonly arpStats = new ArpStats();
  private ipRoutingEnabled = false;

  // ─── Dynamic ARP Inspection ────────────────────────────────────
  private arpInspection: ArpInspectionConfig = createDefaultArpInspectionConfig();
  private arpAccessLists: Map<string, ArpAccessList> = new Map();
  private arpErrDisabledPorts: Set<string> = new Set();
  private arpInspectionPipeline: ArpInspectionPipeline | null = null;
  private arpRecoveryTimer: TimerHandle | null = null;
  private arpRecoveryScheduler: IScheduler | null = null;
  private arpErrDisableTimestamps: Map<string, number> = new Map();
  private arpUnsubscribers: Array<() => void> = [];
  private dhcpSnoopingUnsubscribers: Array<() => void> = [];

  // ─── Port-Security err-disable + aging ─────────────────────────
  private psecRecoverySec: number = 0;
  private psecErrDisabledPorts: Set<string> = new Set();
  private psecErrDisableTimestamps: Map<string, number> = new Map();
  private psecRecoveryTimer: TimerHandle | null = null;
  private psecRecoveryScheduler: IScheduler | null = null;
  private psecAgingTimer: TimerHandle | null = null;
  private psecAgingScheduler: IScheduler | null = null;
  private psecUnsubscribers: Array<() => void> = [];

  /**
   * Les interfaces LoopBack de la boîte. VRP en autorise sur un switch
   * L3 et c'est le procédé normal pour fixer un identifiant de routeur —
   * une adresse qui ne tombe pas avec un port. Elles sont toujours up :
   * c'est la définition d'une loopback, pas un raccourci.
   */
  private readonly loopbacks = new Map<string, { name: string; ip?: IPAddress; mask?: SubnetMask }>();

  // ─── L3 Management Plane (SVIs) ────────────────────────────────
  private readonly svi: SwitchSvi = new SwitchSvi({
    getNonSviLocalIps: () => [...this.loopbacks.values()]
      .map((l) => l.ip).filter((ip): ip is IPAddress => ip !== undefined),
    deviceId: this.id,
    getHostname: () => this.getHostname(),
    getBridgeMac: () => this.getBridgeMac(),
    egressOnVlan: (vlan, frame) => this.egressOnVlan(vlan, frame),
    vlanHasActivePort: (vlan) => this.vlanHasActivePort(vlan),
    dhcpClientDeliver: (vlan, pkt) => {
      const iface = this.sviClientIface(vlan);
      if (iface === null) return false;
      this.dhcpClientAgent.deliver(iface, pkt);
      return true;
    },
    lookupArp: (ip) => this.arpTable.get(ip)?.mac ?? null,
    forgetArp: (ip: string) => {
      const existing = this.arpTable.get(ip);
      if (existing && existing.type !== 'static') this.arpTable.delete(ip);
    },
    learnArp: (ip, mac, iface) => {
      const existing = this.arpTable.get(ip);
      if (existing && existing.type === 'static') return;
      this.arpTable.set(ip, { mac, iface, timestamp: Date.now(), type: 'dynamic' });
    },
    fhrpVipArpOwner: (vlanIf, targetIp, requesterIp) =>
      this._vrrpAgent?.vipArpOwner(vlanIf, targetIp, requesterIp)
      ?? this._hsrpAgent?.vipArpOwner(vlanIf, targetIp, requesterIp)
      ?? this._glbpAgent?.vipArpOwner(vlanIf, targetIp, requesterIp)
      ?? null,
    icmpUnreachablesEnabled: (vlan) =>
      !getSecurityConfig(this).ifaceFlags(`Vlan${vlan}`).noUnreachables,
    isDhcpRelayInfoEnabled: () => this.dhcpServer.isRelayInformationOptionEnabled(),
    getDhcpServer: () => this.dhcpServer,
    recordArp: (dir, op) => this.arpStats.record(dir, op),
    natTranslateInbound: (pkt, inIface) => this.getNATEngine()?.translateInbound(pkt, inIface) ?? null,
    natTranslateOutbound: (pkt, outIface, inIface, opts) =>
      this.getNATEngine()?.translateOutbound(pkt, outIface, inIface, opts) ?? null,
    natIsOutsideInterface: (iface) => this.getNATEngine()?.isOutsideInterface(iface) ?? false,
    deliverLocalUdp: (sourceIP, destinationPort, sourcePort, payload) => {
      // Le port 123 va au moteur NTP, exactement comme sur un routeur.
      // Sans cet aiguillage, un commutateur configure en client NTP
      // emettrait ses requetes et n'entendrait jamais la reponse.
      if (destinationPort === UDP_PORT_NTP || sourcePort === UDP_PORT_NTP) {
        const svi = this.getSvis().find((s) => s.ip);
        if (svi && this._ntpAgent) {
          this._ntpAgent.handleUdp(`Vlanif${svi.vlan}`, sourceIP, {
            type: 'udp', sourcePort, destinationPort,
            length: 8 + 48, checksum: 0, payload,
          } as UDPPacket);
          return true;
        }
      }
      return this.udpEndpoint?.deliver(sourceIP, destinationPort, sourcePort, payload) ?? false;
    },
  });

  private udpEndpoint: ControlPlaneUdpEndpoint | null = null;

  /**
   * Les ports UDP que le plan de controle de CE commutateur tient
   * ouverts — la meme table que le routeur, parce qu'un Catalyst fait
   * `copy running-config tftp:` exactement comme un ISR et qu'ecrire
   * deux tables donnerait deux reponses a la meme question.
   */
  getUdpEndpoint(): ControlPlaneUdpEndpoint {
    if (!this.udpEndpoint) {
      this.udpEndpoint = new ControlPlaneUdpEndpoint({
        sendUdpBytes: (dst, dstPort, srcPort, payload) =>
          this.svi.sendUdpBytes(dst, dstPort, srcPort, payload),
      });
    }
    return this.udpEndpoint;
  }

  private getNATEngine(): import('./router/NATEngine').NATEngine | null {
    return (this as unknown as { _getNATEngine?: () => import('./router/NATEngine').NATEngine })._getNATEngine?.() ?? null;
  }

  // ─── CLI Shell ──────────────────────────────────────────────────
  private shell: ISwitchShell;

  constructor(type: DeviceType = 'switch-cisco', name: string = 'Switch', portCount: number = 50, x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.initialHostname = name;
    this.initPorts(portCount);
    this.initDefaultVLAN();
    this.startMACAgingProcess();
    this.shell = this.createShell();
    this.attachLoggingBus(this.getBus());
    this.initArpInspection();
    this.initPortSecurity();
    this.initDhcpSnooping();
    this.dhcpServer.setEventBus(this.getBus());
    this.dhcpServer.setDeviceId(this.id, this.name);
  }

  private initPortSecurity(): void {
    // React to violations on our own ports: log + auto err-disable book-keeping.
    this.psecUnsubscribers.push(this.getBus().subscribeWhere(
      'port.security.violation',
      (p) => p.deviceId === this.id,
      (e) => {
        const { portName, mac, mode, action } = e.payload;
        const ts = new Date().toISOString();
        this.snoopingLog.push(
          `*${ts}: %PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred,` +
          ` caused by MAC address ${mac.toString().toLowerCase()} on port ${portName}` +
          ` (mode=${mode}, action=${action})`,
        );
        if (action === 'shutdown') {
          this.psecErrDisabledPorts.add(portName);
          this.psecErrDisableTimestamps.set(portName, Date.now());
          if (this.psecRecoverySec > 0) this.ensurePsecRecoveryTimer();
        }
      },
    ));

    // React to sticky-saved on our own ports: the running-config dirty
    // bit is implicit (NVRAM is rebuilt from PortSecurity on each
    // `getRunningConfig`), but we still log it so `show logging` shows
    // the trail just like real IOS does.
    this.psecUnsubscribers.push(this.getBus().subscribeWhere(
      'port.security.sticky-saved',
      (p) => p.deviceId === this.id,
      (e) => {
        const { portName, mac } = e.payload;
        const ts = new Date().toISOString();
        this.snoopingLog.push(
          `*${ts}: %PORT_SECURITY-6-STICKY_LEARN: ${portName} learned sticky MAC ${mac.toString().toLowerCase()}`,
        );
      },
    ));

    // Aging tick: every minute, walk all ports and let PortSecurity drop
    // expired entries. We don't run when no port has aging configured.
    this.startPsecAgingProcess();
  }

  private ensurePsecRecoveryTimer(): void {
    if (this.psecRecoveryTimer !== null || this.psecRecoverySec <= 0) return;
    const scheduler = this.getScheduler();
    this.psecRecoveryScheduler = scheduler;
    this.psecRecoveryTimer = scheduler.setInterval(() => this.recoverPsecErrDisabled(), 1000);
  }

  private recoverPsecErrDisabled(): void {
    if (this.psecRecoverySec <= 0 || this.psecErrDisabledPorts.size === 0) {
      this.stopPsecRecoveryTimer();
      return;
    }
    const now = Date.now();
    for (const port of [...this.psecErrDisabledPorts]) {
      const ts = this.psecErrDisableTimestamps.get(port) ?? now;
      if ((now - ts) / 1000 >= this.psecRecoverySec) {
        this.psecErrDisabledPorts.delete(port);
        this.psecErrDisableTimestamps.delete(port);
        const p = this.getPort(port);
        if (p) {
          p.getPortSecurity().resetViolationCount();
          p.setUp(true);
        }
        this.getBus().publish({
          topic: 'port.security.errdisable.cleared',
          payload: { deviceId: this.id, portName: port },
        });
      }
    }
    if (this.psecErrDisabledPorts.size === 0) this.stopPsecRecoveryTimer();
  }

  private stopPsecRecoveryTimer(): void {
    if (this.psecRecoveryTimer !== null) {
      (this.psecRecoveryScheduler ?? this.getScheduler()).clear(this.psecRecoveryTimer);
      this.psecRecoveryTimer = null;
      this.psecRecoveryScheduler = null;
    }
  }

  private startPsecAgingProcess(): void {
    if (this.psecAgingTimer !== null) return;
    const scheduler = this.getScheduler();
    this.psecAgingScheduler = scheduler;
    this.psecAgingTimer = scheduler.setInterval(() => this.tickPsecAging(), 60_000);
  }

  private stopPsecAgingProcess(): void {
    if (this.psecAgingTimer !== null) {
      (this.psecAgingScheduler ?? this.getScheduler()).clear(this.psecAgingTimer);
      this.psecAgingTimer = null;
      this.psecAgingScheduler = null;
    }
  }

  private tickPsecAging(): void {
    const now = Date.now();
    for (const [portName, port] of this.ports) {
      const sec = port.getPortSecurity();
      if (!sec.isEnabled() || sec.getAgingTimeMin() <= 0) continue;
      const aged = sec.ageOut(now);
      for (const entry of aged) {
        this.getBus().publish({
          topic: 'port.security.mac-aged',
          payload: {
            deviceId: this.id, portName,
            mac: entry.mac, vlan: entry.vlan, type: entry.type,
          },
        });
      }
    }
  }

  private initArpInspection(): void {
    this.arpInspectionPipeline = new ArpInspectionPipeline(
      {
        id: this.id,
        name: this.name,
        _getArpInspectionConfig: () => this.arpInspection,
        _getArpAccessLists: () => this.arpAccessLists,
        _getSnoopingBindings: () => this.snoopingBindings,
        _addSnoopingLog: (msg) => this.snoopingLog.push(msg),
        _arpErrDisable: (port) => this.arpErrDisablePort(port),
        _isArpErrDisabled: (port) => this.arpErrDisabledPorts.has(port),
      },
      () => this.getBus(),
    );

    // React: link going down → drop rate-limit accounting for the port.
    // Counters are kept across flaps to match Cisco's `show ip arp inspection
    // statistics` semantics (only `clear ip arp inspection statistics` zeroes
    // them out).
    this.arpUnsubscribers.push(this.getBus().subscribeWhere(
      'port.link.down',
      (p) => p.deviceId === this.id,
      (e) => this.arpInspectionPipeline?.resetPort(e.payload.portName),
    ));
  }

  private findClientMacEntry(clientMac: string): MACTableEntry | null {
    const mac = clientMac.toLowerCase();
    for (const entry of this.macTable.values()) {
      if (entry.mac === mac) return entry;
    }
    return null;
  }

  private upsertSnoopingBinding(binding: DHCPSnoopingBinding): void {
    const idx = this.snoopingBindings.findIndex((b) => b.macAddress === binding.macAddress && b.vlan === binding.vlan);
    if (idx >= 0) this.snoopingBindings[idx] = binding;
    else this.snoopingBindings.push(binding);
    this.snoopingLog.push(`DHCP_SNOOPING: added binding ${binding.macAddress} ${binding.ipAddress} VLAN ${binding.vlan} ${binding.port}`);
  }

  private removeSnoopingBindingByIp(ip: string): void {
    const idx = this.snoopingBindings.findIndex((b) => b.ipAddress === ip);
    if (idx < 0) return;
    const [removed] = this.snoopingBindings.splice(idx, 1);
    this.snoopingLog.push(`DHCP_SNOOPING: removed binding ${removed.macAddress} ${removed.ipAddress} VLAN ${removed.vlan} ${removed.port}`);
  }

  private tryRecordSnoopingBinding(clientMac: string, ip: string, leaseTimeSec: number, retriesLeft: number): void {
    if (!this.dhcpSnooping.enabled) return;
    const entry = this.findClientMacEntry(clientMac);
    if (!entry) {
      if (retriesLeft > 0) {
        this.getScheduler().setTimeout(
          () => this.tryRecordSnoopingBinding(clientMac, ip, leaseTimeSec, retriesLeft - 1),
          50,
        );
      }
      return;
    }
    if (this.dhcpSnooping.vlans.size > 0 && !this.dhcpSnooping.vlans.has(entry.vlan)) return;
    if (this.dhcpSnooping.trustedPorts.has(entry.port)) return;
    this.upsertSnoopingBinding({
      macAddress: entry.mac,
      ipAddress: ip,
      lease: leaseTimeSec,
      type: 'dynamic',
      vlan: entry.vlan,
      port: entry.port,
    });
  }

  private initDhcpSnooping(): void {
    // Bindings are learned from the DHCP frames this switch forwards
    // (ACK installs, RELEASE removes) — see the DHCP inspection step in
    // handleFrame. No cross-machine bus subscription.
  }

  private arpErrDisablePort(port: string): void {
    if (this.arpErrDisabledPorts.has(port)) return;
    this.arpErrDisabledPorts.add(port);
    this.arpErrDisableTimestamps.set(port, Date.now());
    const p = this.getPort(port);
    if (p) p.setUp(false);
    this.getBus().publish({
      topic: 'arp.errdisable.set',
      payload: { switchId: this.id, switchName: this.name, port, cause: 'arp-inspection' },
    });
    Logger.warn(this.id, 'switch:arp-errdisable',
      `${this.name}: ${port} err-disabled by arp-inspection`);
    this.ensureRecoveryTimer();
  }

  private ensureRecoveryTimer(): void {
    if (this.arpRecoveryTimer !== null) return;
    if (this.arpInspection.errDisableRecoverySec <= 0) return;
    const scheduler = this.getScheduler();
    this.arpRecoveryScheduler = scheduler;
    this.arpRecoveryTimer = scheduler.setInterval(() => this.recoverErrDisabled(), 1000);
  }

  private recoverErrDisabled(): void {
    const recoverySec = this.arpInspection.errDisableRecoverySec;
    if (recoverySec <= 0 || this.arpErrDisabledPorts.size === 0) {
      this.stopRecoveryTimer();
      return;
    }
    const now = Date.now();
    for (const port of [...this.arpErrDisabledPorts]) {
      const ts = this.arpErrDisableTimestamps.get(port) ?? now;
      if ((now - ts) / 1000 >= recoverySec) {
        this.arpErrDisabledPorts.delete(port);
        this.arpErrDisableTimestamps.delete(port);
        const p = this.getPort(port);
        if (p) p.setUp(true);
        this.getBus().publish({
          topic: 'arp.errdisable.cleared',
          payload: { switchId: this.id, switchName: this.name, port },
        });
        Logger.info(this.id, 'switch:arp-recover',
          `${this.name}: ${port} recovered from arp-inspection err-disable`);
      }
    }
    if (this.arpErrDisabledPorts.size === 0) this.stopRecoveryTimer();
  }

  private stopRecoveryTimer(): void {
    if (this.arpRecoveryTimer !== null) {
      (this.arpRecoveryScheduler ?? this.getScheduler()).clear(this.arpRecoveryTimer);
      this.arpRecoveryTimer = null;
      this.arpRecoveryScheduler = null;
    }
  }

  // ─── Vendor Hooks (overridden by subclasses) ───────────────────

  /** Get port name for given index (vendor-specific naming) */
  protected abstract getPortName(index: number, total: number): string;

  /** Get initial STP state for new ports */
  protected abstract getInitialSTPState(): STPPortState;

  /** Create the appropriate CLI shell */
  protected abstract createShell(): ISwitchShell;

  /** Handle ports when their VLAN is deleted (vendor-specific behavior) */
  protected abstract onVlanDeleted(vlanId: number, affectedPorts: string[]): void;

  /** Handle ports when a previously deleted VLAN is recreated */
  protected abstract onVlanRecreated(vlanId: number): string[];

  /** Get OS type string */
  abstract getOSType(): string;

  /** Get boot sequence text */
  abstract getBootSequence(): string;

  private initPorts(count: number): void {
    const initialSTP = this.getInitialSTPState();

    for (let i = 0; i < count; i++) {
      const portName = this.getPortName(i, count);
      const port = new Port(portName, 'ethernet');
      if (portName.startsWith('Fast')) port.setSpeed(100);
      this.addPort(port);

      // Default switchport config: access mode, VLAN 1
      this.switchportConfigs.set(portName, {
        mode: 'access',
        explicitMode: false,
        accessVlan: 1,
        trunkNativeVlan: 1,
        trunkAllowedVlans: VlanSet.all(),
      });

      // STP initial state
      this.stpStates.set(portName, initialSTP);
      // Port VLAN state
      this.portVlanStates.set(portName, 'active');

      // Auto-advance STP on link-up (simulates RSTP rapid transition)
      port.onLinkChange((state) => {
        if (state === 'up') {
          const stp = this.stpStates.get(portName);
          if (stp === 'listening' || stp === 'learning' || stp === 'disabled') {
            this.stpStates.set(portName, 'forwarding');
          }
        } else {
          // Real switches purge dynamic entries the moment a link drops —
          // frames must not chase a dead port for up to 300 s of aging.
          this.stpStates.set(portName, 'disabled');
          this.flushDynamicMacsOnPort(portName, 'link-down');
        }
      });
    }
  }

  private initDefaultVLAN(): void {
    // VLAN 1 is the default VLAN — always exists
    const allPorts = new Set(this.getPortNames());
    this.vlans.set(1, { id: 1, name: 'default', ports: allPorts });
    this.svi.ensure(1);
  }

  override setEventBus(bus: import('@/events/EventBus').IEventBus | null): void {
    super.setEventBus(bus);
    // Subscribers are attached to a specific bus instance — re-install
    // them so they observe the bus that publishes go through.
    for (const u of this.arpUnsubscribers) u();
    this.arpUnsubscribers = [];
    for (const u of this.psecUnsubscribers) u();
    this.psecUnsubscribers = [];
    for (const u of this.dhcpSnoopingUnsubscribers) u();
    this.dhcpSnoopingUnsubscribers = [];
    if (this.arpInspectionPipeline) this.initArpInspection();
    this.initPortSecurity();
    this.initDhcpSnooping();
    if (bus) this.attachLoggingBus(bus);
  }

  // ─── Power Management ────────────────────────────────────────────

  override powerOff(): void {
    super.powerOff();
    this.stopMACAgingProcess();
    this.stopRecoveryTimer();
    this.stopPsecRecoveryTimer();
    this.stopPsecAgingProcess();
    for (const u of this.arpUnsubscribers) u();
    this.arpUnsubscribers = [];
    for (const u of this.psecUnsubscribers) u();
    this.psecUnsubscribers = [];
    for (const u of this.dhcpSnoopingUnsubscribers) u();
    this.dhcpSnoopingUnsubscribers = [];
    this.arpInspectionPipeline?.resetStats();
    this.arpErrDisabledPorts.clear();
    this.arpErrDisableTimestamps.clear();
    this.psecErrDisabledPorts.clear();
    this.psecErrDisableTimestamps.clear();
  }

  override powerOn(): void {
    super.powerOn();
    // Reset volatile state (simulates DRAM loss)
    this.hostname = this.initialHostname;
    this.name = this.initialHostname;
    this.macTable.clear();
    this.vlans.clear();
    this.initDefaultVLAN();
    // Reset all port configs to defaults
    for (const [portName, cfg] of this.switchportConfigs) {
      cfg.mode = 'access';
      cfg.accessVlan = 1;
      cfg.trunkNativeVlan = 1;
      cfg.trunkAllowedVlans = VlanSet.all();
      const port = this.getPort(portName);
      if (port) port.setUp(true);
    }
    // Reset shell FSM to user mode
    this.shell = this.createShell();
    this.attachLoggingBus(this.getBus());
    this.startMACAgingProcess();
    // Reset volatile DAI runtime (keep config — it lives in NVRAM via running-config).
    this.arpErrDisabledPorts.clear();
    this.arpErrDisableTimestamps.clear();
    this.psecErrDisabledPorts.clear();
    this.psecErrDisableTimestamps.clear();
    this.initArpInspection();
    this.initPortSecurity();
    // Restore startup config (NVRAM) if available
    if (this.startupConfig) {
      this.restoreFromStartupConfig();
    }
  }

  // ─── VLAN Database API ────────────────────────────────────────────

  protected isReservedVlanId(_id: number): boolean { return false; }

  createVLAN(id: number, name?: string): boolean {
    if (id < 1 || id > 4094) return false;
    if (this.isReservedVlanId(id)) return false;
    if (this.vlans.has(id)) return false;
    const newVlan: VLANEntry = { id, name: name || `VLAN${String(id).padStart(4, '0')}`, ports: new Set() };
    this.vlans.set(id, newVlan);

    // Let subclass handle VLAN recreation (e.g., Cisco reactivates suspended ports)
    const reactivated = this.onVlanRecreated(id);
    for (const portName of reactivated) {
      newVlan.ports.add(portName);
    }

    Logger.info(this.id, 'switch:vlan-create', `${this.name}: created VLAN ${id}`);
    return true;
  }

  deleteVLAN(id: number): boolean {
    if (id === 1) return false; // Can't delete default VLAN
    if (this.isReservedVlanId(id)) return false;
    if (!this.vlans.has(id)) return false;

    // Collect affected access ports
    const vlan = this.vlans.get(id)!;
    const affectedPorts: string[] = [];
    for (const portName of vlan.ports) {
      const cfg = this.switchportConfigs.get(portName);
      if (cfg && cfg.mode === 'access' && cfg.accessVlan === id) {
        affectedPorts.push(portName);
      }
    }

    // Let subclass handle port behavior (Cisco: suspend, Huawei: move to VLAN 1)
    this.onVlanDeleted(id, affectedPorts);

    this.vlans.delete(id);
    // Remove MAC entries for this VLAN
    for (const [key, entry] of this.macTable) {
      if (entry.vlan === id) this.macTable.delete(key);
    }
    Logger.info(this.id, 'switch:vlan-delete', `${this.name}: deleted VLAN ${id}`);
    return true;
  }

  renameVLAN(id: number, name: string): boolean {
    const vlan = this.vlans.get(id);
    if (!vlan) return false;
    vlan.name = name;
    return true;
  }

  getVLAN(id: number): VLANEntry | undefined {
    return this.vlans.get(id);
  }

  getVLANs(): Map<number, VLANEntry> {
    return new Map(this.vlans);
  }

  // ─── Switchport Configuration API ─────────────────────────────────

  resolveSnoopingVlan(portName: string): number | undefined {
    const cfg = this.getSwitchportConfig(portName);
    if (!cfg) return undefined;
    if (cfg.mode === 'access') return cfg.accessVlan;
    if (cfg.mode === 'trunk') return cfg.trunkNativeVlan;
    if (cfg.mode === 'hybrid') return cfg.hybridPvid ?? 1;
    return undefined;
  }

  getSwitchportConfig(portName: string): SwitchportConfig | undefined {
    return this.switchportConfigs.get(portName);
  }

  /**
   * A Port-channel carries its own layer-2 configuration on IOS, and the
   * members take it when they join the group. It has no `Port` of its
   * own here, so the entry is created on demand.
   */
  ensureAggregateSwitchportConfig(name: string): SwitchportConfig {
    let cfg = this.switchportConfigs.get(name);
    if (!cfg) {
      cfg = {
        mode: 'access', explicitMode: false, accessVlan: 1,
        trunkNativeVlan: 1, trunkAllowedVlans: VlanSet.all(),
      };
      this.switchportConfigs.set(name, cfg);
    }
    return cfg;
  }

  /**
   * Copy an aggregate's layer-2 configuration onto a joining member.
   * Goes through the ordinary setters so the side effects a member gets
   * from a typed command — VLAN membership, DTP admin mode — happen here
   * too rather than being half-applied by a raw write.
   */
  inheritAggregateSwitchport(aggregate: string, member: string): void {
    const source = this.switchportConfigs.get(aggregate);
    const cible = this.switchportConfigs.get(member);
    if (!source || !cible) return;
    cible.trunkAllowedVlans = source.trunkAllowedVlans.clone();
    cible.trunkNativeVlan = source.trunkNativeVlan;
    cible.hybridPvid = source.hybridPvid;
    if (source.explicitMode) this.setSwitchportMode(member, source.mode);
    if (source.mode === 'access') this.setSwitchportAccessVlan(member, source.accessVlan);
    else cible.accessVlan = source.accessVlan;
  }

  /**
   * Whether `proto`'s control frames arriving on `portName` must be relayed
   * as opaque data (L2PT) instead of handed to this switch's own agent —
   * true only on a dot1q-tunnel port with that protocol listed.
   */
  protected isL2ProtocolTunneled(portName: string, proto: 'cdp' | 'stp' | 'vtp' | 'lldp'): boolean {
    const cfg = this.switchportConfigs.get(portName);
    return cfg?.mode === 'dot1q-tunnel' && (cfg.l2ptProtocols?.has(proto) ?? false);
  }

  /**
   * `l2protocol-tunnel <proto>` / `bpdu-tunnel <proto> enable`: mark a
   * dot1q-tunnel port's control-protocol frames as opaque relayed data
   * instead of local agent input (see `isL2ProtocolTunneled`).
   */
  enableL2ProtocolTunnel(portName: string, proto: 'cdp' | 'stp' | 'vtp' | 'lldp'): void {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return;
    if (!cfg.l2ptProtocols) cfg.l2ptProtocols = new Set();
    cfg.l2ptProtocols.add(proto);
    if (proto === 'stp') {
      // No spanning-tree instance governs this port any more (its BPDUs are
      // opaque relayed data, per getStpPortVlans) — it must not sit stuck in
      // listening/learning waiting on a local election that will never run.
      this.setSTPState(portName, 'forwarding');
    }
  }

  /**
   * VLAN-membership bookkeeping for a switchport mode change — no DTP
   * admin-mode side effect. Used both by the CLI-facing `setSwitchportMode`
   * below and by DTP's own operational-mode sync (which must update this
   * bookkeeping without feeding back into DTP's own admin-mode state).
   */
  protected syncSwitchportMode(portName: string, mode: SwitchportMode): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;

    const oldMode = cfg.mode;
    cfg.mode = mode;

    const oldIsVlanMember = oldMode === 'access' || oldMode === 'dot1q-tunnel';
    const newIsVlanMember = mode === 'access' || mode === 'dot1q-tunnel';

    if (oldIsVlanMember && !newIsVlanMember) {
      // Remove from VLAN port list when leaving access/dot1q-tunnel
      const vlan = this.vlans.get(cfg.accessVlan);
      if (vlan) vlan.ports.delete(portName);
    } else if (!oldIsVlanMember && newIsVlanMember) {
      // Add to access VLAN (or S-VLAN) port list
      const vlan = this.vlans.get(cfg.accessVlan);
      if (vlan) vlan.ports.add(portName);
    }

    Logger.info(this.id, 'switch:switchport-mode', `${this.name}: ${portName} set to ${mode}`);
    return true;
  }

  setSwitchportMode(portName: string, mode: SwitchportMode): boolean {
    if (!this.syncSwitchportMode(portName, mode)) return false;
    const cfg = this.switchportConfigs.get(portName);
    if (cfg) cfg.explicitMode = true;

    const dtp = (this as unknown as { getDtpAgent?: () => { setAdminMode(p: string, m: string): void } }).getDtpAgent?.();
    dtp?.setAdminMode(portName, mode === 'trunk' ? 'trunk' : 'access');

    return true;
  }

  setSwitchportAccessVlan(portName: string, vlanId: number): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    if (!this.vlans.has(vlanId)) {
      // Auto-create VLAN if it doesn't exist
      this.createVLAN(vlanId);
    }

    // Remove from old VLAN
    const oldVlan = this.vlans.get(cfg.accessVlan);
    if (oldVlan) oldVlan.ports.delete(portName);

    // Add to new VLAN
    cfg.accessVlan = vlanId;
    const newVlan = this.vlans.get(vlanId);
    if (newVlan && (cfg.mode === 'access' || cfg.mode === 'dot1q-tunnel')) newVlan.ports.add(portName);

    this.flushDynamicMacsOnPort(portName, 'access-vlan-change');

    Logger.info(this.id, 'switch:access-vlan', `${this.name}: ${portName} access VLAN ${vlanId}`);
    return true;
  }

  // ─── Private VLAN (PVLAN) configuration API ────────────────────────

  setPrivateVlanRole(vlanId: number, role: PrivateVlanRole): { ok: boolean; error?: string } {
    if (!this.vlans.has(vlanId)) return { ok: false, error: `VLAN ${vlanId} does not exist` };
    this.pvlanRoles.set(vlanId, role);
    return { ok: true };
  }

  getPrivateVlanRole(vlanId: number): PrivateVlanRole | undefined {
    return this.pvlanRoles.get(vlanId);
  }

  associatePrivateVlan(primaryVlanId: number, secondaryVlanIds: number[]): { ok: boolean; error?: string } {
    if (this.pvlanRoles.get(primaryVlanId) !== 'primary') {
      return { ok: false, error: `VLAN ${primaryVlanId} is not a primary private VLAN` };
    }
    const existing = this.pvlanAssociations.get(primaryVlanId) ?? new Set<number>();
    for (const sec of secondaryVlanIds) {
      const role = this.pvlanRoles.get(sec);
      if (role !== 'isolated' && role !== 'community') {
        return { ok: false, error: `VLAN ${sec} is not a secondary private VLAN` };
      }
      const currentPrimary = this.pvlanSecondaryToPrimary.get(sec);
      if (currentPrimary !== undefined && currentPrimary !== primaryVlanId) {
        return { ok: false, error: `VLAN ${sec} is already associated with primary VLAN ${currentPrimary}` };
      }
      if (role === 'isolated') {
        for (const other of existing) {
          if (other !== sec && this.pvlanRoles.get(other) === 'isolated') {
            return { ok: false, error: `Primary VLAN ${primaryVlanId} already has an isolated secondary VLAN` };
          }
        }
      }
    }
    for (const sec of secondaryVlanIds) {
      existing.add(sec);
      this.pvlanSecondaryToPrimary.set(sec, primaryVlanId);
    }
    this.pvlanAssociations.set(primaryVlanId, existing);
    return { ok: true };
  }

  getPrivateVlanAssociations(primaryVlanId: number): Set<number> {
    return new Set(this.pvlanAssociations.get(primaryVlanId) ?? []);
  }

  configurePvlanHostPort(portName: string, primaryVlanId: number, secondaryVlanId: number): { ok: boolean; error?: string } {
    const assoc = this.pvlanAssociations.get(primaryVlanId);
    if (!assoc || !assoc.has(secondaryVlanId)) {
      return { ok: false, error: `VLAN ${secondaryVlanId} is not associated with primary VLAN ${primaryVlanId}` };
    }
    if (!this.setSwitchportAccessVlan(portName, secondaryVlanId)) return { ok: false, error: '% Error' };
    const hostKind = this.pvlanRoles.get(secondaryVlanId) as 'isolated' | 'community';
    this.pvlanPorts.set(portName, { role: 'host', hostKind, primaryVlan: primaryVlanId, secondaryVlan: secondaryVlanId });
    return { ok: true };
  }

  configurePvlanPromiscuousPort(portName: string, primaryVlanId: number, secondaryVlanIds: number[]): { ok: boolean; error?: string } {
    if (this.pvlanRoles.get(primaryVlanId) !== 'primary') {
      return { ok: false, error: `VLAN ${primaryVlanId} is not a primary private VLAN` };
    }
    const assoc = this.pvlanAssociations.get(primaryVlanId) ?? new Set<number>();
    for (const sec of secondaryVlanIds) {
      if (!assoc.has(sec)) return { ok: false, error: `VLAN ${sec} is not associated with primary VLAN ${primaryVlanId}` };
    }
    if (!this.setSwitchportAccessVlan(portName, primaryVlanId)) return { ok: false, error: '% Error' };
    this.pvlanPorts.set(portName, { role: 'promiscuous', primaryVlan: primaryVlanId, mappedSecondaryVlans: new Set(secondaryVlanIds) });
    return { ok: true };
  }

  getPrivateVlanPortConfig(portName: string): PrivateVlanPortConfig | undefined {
    return this.pvlanPorts.get(portName);
  }

  setPrivateVlanSviMapping(primaryVlanId: number, secondaryVlanIds: number[]): void {
    this.pvlanSviMappings.set(primaryVlanId, new Set(secondaryVlanIds));
  }

  getPrivateVlanSviMapping(primaryVlanId: number): Set<number> {
    return new Set(this.pvlanSviMappings.get(primaryVlanId) ?? []);
  }

  private resolvePvlanPrimary(vlan: number): number | undefined {
    if (this.pvlanRoles.get(vlan) === 'primary') return vlan;
    return this.pvlanSecondaryToPrimary.get(vlan);
  }

  private resolvePvlanSviTarget(vlan: number): number {
    const primary = this.resolvePvlanPrimary(vlan);
    if (primary === undefined || primary === vlan) return vlan;
    return this.pvlanSviMappings.get(primary)?.has(vlan) ? primary : vlan;
  }

  private pvlanEgressAllowed(ingressPort: string, egressPort: string, vlan: number): boolean {
    const primary = this.resolvePvlanPrimary(vlan);
    if (primary === undefined) return true;
    const eg = this.pvlanPorts.get(egressPort);
    if (!eg || eg.primaryVlan !== primary) return false;
    if (!ingressPort) return true;
    const ing = this.pvlanPorts.get(ingressPort)
      ?? this.derivePvlanSourceConfig(ingressPort, vlan, primary);
    if (!ing || ing.primaryVlan !== primary) return false;
    if (eg.role === 'promiscuous' || ing.role === 'promiscuous') return true;
    if (ing.hostKind === 'isolated' || eg.hostKind === 'isolated') return false;
    return ing.secondaryVlan === eg.secondaryVlan;
  }

  private derivePvlanSourceConfig(ingressPort: string, vlan: number, primary: number): PrivateVlanPortConfig | undefined {
    const cfg = this.switchportConfigs.get(ingressPort);
    if (!cfg || cfg.mode === 'access') return undefined;
    const role = this.pvlanRoles.get(vlan);
    if (role === 'primary') return { role: 'promiscuous', primaryVlan: primary };
    if (role === 'isolated') return { role: 'host', hostKind: 'isolated', primaryVlan: primary, secondaryVlan: vlan };
    if (role === 'community') return { role: 'host', hostKind: 'community', primaryVlan: primary, secondaryVlan: vlan };
    return undefined;
  }

  private pvlanTrunkEgressVlan(pv: PrivateVlanPortConfig, vlan: number): number {
    if (pv.role === 'promiscuous') {
      return pv.mappedSecondaryVlans?.has(vlan) ? pv.primaryVlan : vlan;
    }
    if (vlan === pv.primaryVlan && pv.secondaryVlan !== undefined) return pv.secondaryVlan;
    return vlan;
  }

  configurePvlanPromiscuousTrunk(portName: string, primaryVlanId: number, secondaryVlanIds: number[]): { ok: boolean; error?: string } {
    if (this.pvlanRoles.get(primaryVlanId) !== 'primary') {
      return { ok: false, error: `VLAN ${primaryVlanId} is not a primary private VLAN` };
    }
    const assoc = this.pvlanAssociations.get(primaryVlanId) ?? new Set<number>();
    for (const sec of secondaryVlanIds) {
      if (!assoc.has(sec)) return { ok: false, error: `VLAN ${sec} is not associated with primary VLAN ${primaryVlanId}` };
    }
    this.pvlanPorts.set(portName, { role: 'promiscuous', primaryVlan: primaryVlanId, mappedSecondaryVlans: new Set(secondaryVlanIds) });
    return { ok: true };
  }

  configurePvlanIsolatedTrunk(portName: string, primaryVlanId: number, secondaryVlanId: number): { ok: boolean; error?: string } {
    const assoc = this.pvlanAssociations.get(primaryVlanId);
    if (!assoc || !assoc.has(secondaryVlanId)) {
      return { ok: false, error: `VLAN ${secondaryVlanId} is not associated with primary VLAN ${primaryVlanId}` };
    }
    const hostKind = this.pvlanRoles.get(secondaryVlanId) as 'isolated' | 'community';
    this.pvlanPorts.set(portName, { role: 'host', hostKind, primaryVlan: primaryVlanId, secondaryVlan: secondaryVlanId });
    return { ok: true };
  }

  // ─── Port isolation (Huawei port-isolate) ──────────────────────────

  setPortIsolateGroup(portName: string, group: number): void {
    this.portIsolateGroups.set(portName, group);
  }

  clearPortIsolateGroup(portName: string): void {
    this.portIsolateGroups.delete(portName);
  }

  getPortIsolateGroup(portName: string): number | undefined {
    return this.portIsolateGroups.get(portName);
  }

  /**
   * `switchport protected` — le nom Cisco de ce que VRP appelle
   * `port-isolate`, et donc la MÊME règle plutôt qu'une seconde.
   *
   * La seule différence est le groupe : VRP le numérote, IOS n'en a
   * qu'un, implicite — deux ports protégés du même commutateur ne
   * s'échangent rien, un port protégé et un port ordinaire dialoguent
   * normalement.
   */
  setPortProtected(portName: string, on: boolean): void {
    if (on) this.protectedPorts.add(portName);
    else this.protectedPorts.delete(portName);
  }

  isPortProtected(portName: string): boolean {
    return this.protectedPorts.has(portName);
  }

  private portIsolateBlocks(ingressPort: string, egressPort: string): boolean {
    if (!ingressPort) return false;
    if (this.protectedPorts.has(ingressPort) && this.protectedPorts.has(egressPort)) {
      return true;
    }
    const ingGroup = this.portIsolateGroups.get(ingressPort);
    const egGroup = this.portIsolateGroups.get(egressPort);
    return ingGroup !== undefined && ingGroup === egGroup;
  }

  // ─── Super-VLAN / Sub-VLAN (Huawei aggregate-vlan / access-vlan) ───

  setSuperVlan(vlanId: number): { ok: boolean; error?: string } {
    if (!this.vlans.has(vlanId)) return { ok: false, error: `VLAN ${vlanId} does not exist` };
    this.superVlanIds.add(vlanId);
    return { ok: true };
  }

  isSuperVlan(vlanId: number): boolean {
    return this.superVlanIds.has(vlanId);
  }

  setSubVlanList(superVlanId: number, subVlanIds: number[]): { ok: boolean; error?: string } {
    if (!this.superVlanIds.has(superVlanId)) {
      return { ok: false, error: `VLAN ${superVlanId} is not a super-VLAN` };
    }
    const existing = this.superVlanSubVlans.get(superVlanId) ?? new Set<number>();
    for (const sub of subVlanIds) {
      if (!this.vlans.has(sub)) return { ok: false, error: `VLAN ${sub} does not exist` };
      const currentSuper = this.subVlanToSuperVlan.get(sub);
      if (currentSuper !== undefined && currentSuper !== superVlanId) {
        return { ok: false, error: `VLAN ${sub} is already a sub-VLAN of super-VLAN ${currentSuper}` };
      }
    }
    for (const sub of subVlanIds) {
      existing.add(sub);
      this.subVlanToSuperVlan.set(sub, superVlanId);
    }
    this.superVlanSubVlans.set(superVlanId, existing);
    return { ok: true };
  }

  getSubVlans(superVlanId: number): Set<number> {
    return new Set(this.superVlanSubVlans.get(superVlanId) ?? []);
  }

  getSuperVlanOf(subVlanId: number): number | undefined {
    return this.subVlanToSuperVlan.get(subVlanId);
  }

  private resolveSviTarget(vlan: number): number {
    const pvlanTarget = this.resolvePvlanSviTarget(vlan);
    if (pvlanTarget !== vlan) return pvlanTarget;
    return this.subVlanToSuperVlan.get(vlan) ?? vlan;
  }

  private superVlanReaches(vlan: number, candidateAccessVlan: number): boolean {
    if (!this.superVlanIds.has(vlan)) return false;
    return this.superVlanSubVlans.get(vlan)?.has(candidateAccessVlan) ?? false;
  }

  // ─── Hybrid port (Huawei) API ──────────────────────────────────────

  setHybridMode(portName: string): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    if (cfg.mode === 'access') {
      const vlan = this.vlans.get(cfg.accessVlan);
      if (vlan) vlan.ports.delete(portName);
    }
    cfg.mode = 'hybrid';
    cfg.hybridPvid = cfg.hybridPvid ?? 1;
    cfg.hybridUntaggedVlans = cfg.hybridUntaggedVlans ?? new Set([1]);
    cfg.hybridTaggedVlans = cfg.hybridTaggedVlans ?? new Set();
    return true;
  }

  setHybridPvid(portName: string, vlanId: number): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg || cfg.mode !== 'hybrid') return false;
    cfg.hybridPvid = vlanId;
    return true;
  }

  addHybridUntaggedVlans(portName: string, vlanIds: number[]): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg || cfg.mode !== 'hybrid') return false;
    cfg.hybridUntaggedVlans = cfg.hybridUntaggedVlans ?? new Set();
    for (const v of vlanIds) {
      cfg.hybridUntaggedVlans.add(v);
      cfg.hybridTaggedVlans?.delete(v);
    }
    return true;
  }

  addHybridTaggedVlans(portName: string, vlanIds: number[]): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg || cfg.mode !== 'hybrid') return false;
    cfg.hybridTaggedVlans = cfg.hybridTaggedVlans ?? new Set();
    for (const v of vlanIds) {
      cfg.hybridTaggedVlans.add(v);
      cfg.hybridUntaggedVlans?.delete(v);
    }
    return true;
  }

  // ─── VLAN Access Map (Cisco VACL) API ──────────────────────────────

  vlanAccessMapRunningConfigLines(): string[] {
    const out: string[] = [];
    for (const [name, rules] of this.vlanAccessMaps) {
      for (const rule of rules) {
        out.push(`vlan access-map ${name} ${rule.sequence}`);
        if (rule.matchIpAcl) out.push(` match ip address ${rule.matchIpAcl}`);
        out.push(` action ${rule.action}`);
      }
    }
    return out;
  }

  getVaclEngine(): ACLEngine {
    if (!this.vaclEngine) this.vaclEngine = new ACLEngine();
    return this.vaclEngine;
  }

  setVlanAccessMapRule(mapName: string, sequence: number): VlanAccessMapRule {
    const rules = this.vlanAccessMaps.get(mapName) ?? [];
    let rule = rules.find(r => r.sequence === sequence);
    if (!rule) {
      rule = { sequence, action: 'forward' };
      rules.push(rule);
      rules.sort((a, b) => a.sequence - b.sequence);
    }
    this.vlanAccessMaps.set(mapName, rules);
    return rule;
  }

  getVlanAccessMap(mapName: string): VlanAccessMapRule[] | undefined {
    return this.vlanAccessMaps.get(mapName);
  }

  getVlanAccessMapNames(): string[] {
    return [...this.vlanAccessMaps.keys()];
  }

  /** Quels VLAN chaque carte filtre-t-elle ? Lu par `show vlan filter`. */
  getVlanFilterBindings(): Map<string, number[]> {
    const parCarte = new Map<string, number[]>();
    for (const [vlan, name] of this.vlanFilterBindings) {
      const liste = parCarte.get(name) ?? [];
      liste.push(vlan);
      parCarte.set(name, liste);
    }
    for (const liste of parCarte.values()) liste.sort((a, b) => a - b);
    return parCarte;
  }

  removeVlanAccessMap(mapName: string): boolean {
    for (const [vlan, name] of this.vlanFilterBindings) {
      if (name === mapName) this.vlanFilterBindings.delete(vlan);
    }
    return this.vlanAccessMaps.delete(mapName);
  }

  applyVlanFilter(mapName: string, vlans: number[]): { ok: boolean; error?: string } {
    if (!this.vlanAccessMaps.has(mapName)) {
      return { ok: false, error: `VLAN access-map ${mapName} does not exist` };
    }
    for (const v of vlans) this.vlanFilterBindings.set(v, mapName);
    return { ok: true };
  }

  removeVlanFilter(mapName: string, vlans?: number[]): void {
    for (const [vlan, name] of this.vlanFilterBindings) {
      if (name !== mapName) continue;
      if (!vlans || vlans.includes(vlan)) this.vlanFilterBindings.delete(vlan);
    }
  }

  getVlanFilter(vlan: number): string | undefined {
    return this.vlanFilterBindings.get(vlan);
  }

  private vaclPermits(vlan: number, frame: EthernetFrame): boolean {
    const mapName = this.vlanFilterBindings.get(vlan);
    if (!mapName) return true;
    const rules = this.vlanAccessMaps.get(mapName);
    if (!rules || rules.length === 0) return true;
    if (frame.etherType !== ETHERTYPE_IPV4) return true;
    const ip = frame.payload as IPv4Packet | undefined;
    if (!ip || ip.type !== 'ipv4') return true;
    for (const rule of rules) {
      if (!rule.matchIpAcl) return rule.action === 'forward';
      if (this.getVaclEngine().evaluateACLByName(rule.matchIpAcl, ip) === 'permit') {
        return rule.action === 'forward';
      }
    }
    return false;
  }

  /** Huawei `traffic-filter inbound|outbound acl <N>` on a physical port. */
  private portAclPermits(portName: string, direction: 'in' | 'out', frame: EthernetFrame): boolean {
    if (!this.vaclEngine) return true;
    const aclRef = this.vaclEngine.getInterfaceACL(portName, direction);
    if (aclRef === null) return true;
    if (frame.etherType !== ETHERTYPE_IPV4) return true;
    const ip = frame.payload as IPv4Packet | undefined;
    if (!ip || ip.type !== 'ipv4') return true;
    return this.vaclEngine.evaluateForDataPlane(aclRef, ip) !== 'deny';
  }

  // ─── MQC (Huawei traffic classifier/behavior/policy) API ──────────

  mqcEnsureClassifier(name: string): void {
    if (!this.mqcClassifiers.has(name)) this.mqcClassifiers.set(name, []);
  }

  mqcClassifierAddMatch(name: string, match: MqcMatch): { ok: boolean; error?: string } {
    const list = this.mqcClassifiers.get(name);
    if (!list) return { ok: false, error: `Traffic classifier ${name} does not exist` };
    const line = mqcMatchLine(match);
    if (!list.some(existing => mqcMatchLine(existing) === line)) list.push(match);
    return { ok: true };
  }

  mqcClassifierAddMatchAcl(name: string, aclRef: string): { ok: boolean; error?: string } {
    return this.mqcClassifierAddMatch(name, { kind: 'acl', ref: aclRef });
  }

  getMqcClassifier(name: string): MqcMatch[] | undefined {
    return this.mqcClassifiers.get(name);
  }

  getMqcClassifierNames(): string[] { return [...this.mqcClassifiers.keys()]; }
  getMqcBehaviorNames(): string[] { return [...this.mqcBehaviors.keys()]; }
  getMqcPolicyNames(): string[] { return [...this.mqcPolicies.keys()]; }

  mqcEnsureBehavior(name: string): void {
    if (!this.mqcBehaviors.has(name)) this.mqcBehaviors.set(name, 'permit');
  }

  mqcBehaviorSetCar(name: string, rule: CarRule): { ok: boolean; error?: string } {
    if (!this.mqcBehaviors.has(name)) return { ok: false, error: `Traffic behavior ${name} does not exist` };
    this.mqcBehaviorCar.set(name, rule);
    return { ok: true };
  }

  mqcBehaviorClearCar(name: string): void {
    this.mqcBehaviorCar.delete(name);
  }

  mqcBehaviorSetRemark(name: string, remark: MqcRemark): { ok: boolean; error?: string } {
    if (!this.mqcBehaviors.has(name)) return { ok: false, error: `Traffic behavior ${name} does not exist` };
    this.mqcBehaviorRemark.set(name, { ...this.mqcBehaviorRemark.get(name), ...remark });
    return { ok: true };
  }

  mqcBehaviorClearRemark(name: string): void {
    this.mqcBehaviorRemark.delete(name);
  }

  mqcBehaviorSetStatistic(name: string, on: boolean): { ok: boolean; error?: string } {
    if (!this.mqcBehaviors.has(name)) return { ok: false, error: `Traffic behavior ${name} does not exist` };
    if (on) this.mqcBehaviorStatistic.add(name);
    else this.mqcBehaviorStatistic.delete(name);
    return { ok: true };
  }

  mqcBehaviorHasStatistic(name: string): boolean {
    return this.mqcBehaviorStatistic.has(name);
  }

  /**
   * Le compteur suit la MEME cle que le seau CAR — point d'application,
   * classificateur, comportement — parce qu'une politique posee a deux
   * endroits compte deux fois sur une vraie machine.
   */
  getMqcCounters(point: string, classifier: string, behavior: string): MqcCounters | undefined {
    return this.mqcCounters.get(`${point}|${classifier}|${behavior}`);
  }

  clearMqcCounters(): void { this.mqcCounters.clear(); }

  private countMqc(
    point: string, pair: MqcPolicyBinding, bytes: number, passed: boolean,
  ): void {
    if (!this.mqcBehaviorStatistic.has(pair.behavior)) return;
    const key = `${point}|${pair.classifier}|${pair.behavior}`;
    let counters = this.mqcCounters.get(key);
    if (!counters) { counters = emptyMqcCounters(); this.mqcCounters.set(key, counters); }
    counters.matchedPackets++;
    counters.matchedBytes += bytes;
    if (passed) { counters.passedPackets++; counters.passedBytes += bytes; }
    else { counters.droppedPackets++; counters.droppedBytes += bytes; }
  }

  getMqcBehaviorRemark(name: string): MqcRemark | undefined {
    return this.mqcBehaviorRemark.get(name);
  }

  /**
   * RFC 2474 : les six bits de poids fort de l'octet TOS, l'ECN restant
   * intact — c'est le meme decoupage que celui qu'`ACLEngine` compare,
   * donc une marque posee ici est vue par une liste d'acces en aval.
   */
  private applyMqcRemark(behavior: string, frame: EthernetFrame): void {
    const remark = this.mqcBehaviorRemark.get(behavior);
    if (!remark) return;
    if (remark.dscp !== undefined && frame.etherType === ETHERTYPE_IPV4) {
      const ip = frame.payload as IPv4Packet | undefined;
      if (ip && ip.type === 'ipv4') {
        ip.tos = ((remark.dscp & 0x3f) << 2) | (ip.tos & 0x03);
      }
    }
    if (remark.dot1p !== undefined) {
      const tag = (frame as TaggedEthernetFrame).dot1q;
      if (tag) tag.pcp = remark.dot1p & 0x07;
    }
  }

  getMqcBehaviorCar(name: string): CarRule | undefined {
    return this.mqcBehaviorCar.get(name);
  }

  private mqcCarBucket(point: string, behavior: string): CarPolicer | null {
    const configured = this.mqcBehaviorCar.get(behavior);
    if (!configured) return null;
    const key = `${point}|${behavior}`;
    const held = this.mqcCarBuckets.get(key);
    if (held && held.raw === configured.raw) return held.policer;
    const policer = new CarPolicer();
    policer.add(cloneCarRule(configured));
    this.mqcCarBuckets.set(key, { raw: configured.raw, policer });
    return policer;
  }

  mqcBehaviorSetAction(name: string, action: 'permit' | 'deny'): { ok: boolean; error?: string } {
    if (!this.mqcBehaviors.has(name)) return { ok: false, error: `Traffic behavior ${name} does not exist` };
    this.mqcBehaviors.set(name, action);
    return { ok: true };
  }

  getMqcBehavior(name: string): 'permit' | 'deny' | undefined {
    return this.mqcBehaviors.get(name);
  }

  mqcEnsurePolicy(name: string): void {
    if (!this.mqcPolicies.has(name)) this.mqcPolicies.set(name, []);
  }

  mqcPolicyBind(policyName: string, classifier: string, behavior: string): { ok: boolean; error?: string } {
    const pairs = this.mqcPolicies.get(policyName);
    if (!pairs) return { ok: false, error: `Traffic policy ${policyName} does not exist` };
    if (!this.mqcClassifiers.has(classifier)) return { ok: false, error: `Traffic classifier ${classifier} does not exist` };
    if (!this.mqcBehaviors.has(behavior)) return { ok: false, error: `Traffic behavior ${behavior} does not exist` };
    const existing = pairs.find(p => p.classifier === classifier);
    if (existing) existing.behavior = behavior;
    else pairs.push({ classifier, behavior });
    return { ok: true };
  }

  getMqcPolicy(name: string): MqcPolicyBinding[] | undefined {
    return this.mqcPolicies.get(name);
  }

  applyVlanTrafficPolicy(vlan: number, policyName: string): { ok: boolean; error?: string } {
    if (!this.mqcPolicies.has(policyName)) {
      return { ok: false, error: `Traffic policy ${policyName} does not exist` };
    }
    this.vlanTrafficPolicies.set(vlan, policyName);
    return { ok: true };
  }

  removeVlanTrafficPolicy(vlan: number): void {
    this.vlanTrafficPolicies.delete(vlan);
  }

  getVlanTrafficPolicy(vlan: number): string | undefined {
    return this.vlanTrafficPolicies.get(vlan);
  }

  private mqcMatchHits(match: MqcMatch, vlan: number, frame: EthernetFrame): boolean {
    if (match.kind === 'any') return true;
    if (match.kind === 'vlan-id') return match.vlan === vlan;
    if (frame.etherType !== ETHERTYPE_IPV4) return false;
    const ip = frame.payload as IPv4Packet | undefined;
    if (!ip || ip.type !== 'ipv4') return false;
    return this.getVaclEngine().evaluateACLByName(match.ref, ip) === 'permit';
  }

  private mqcPolicyPermits(
    policyName: string, vlan: number, frame: EthernetFrame, point: string,
  ): boolean {
    const pairs = this.mqcPolicies.get(policyName);
    if (!pairs || pairs.length === 0) return true;
    for (const pair of pairs) {
      for (const match of this.mqcClassifiers.get(pair.classifier) ?? []) {
        if (!this.mqcMatchHits(match, vlan, frame)) continue;
        const bytes = ethernetFrameBytes(frame);
        if ((this.mqcBehaviors.get(pair.behavior) ?? 'permit') === 'deny') {
          this.countMqc(point, pair, bytes, false);
          return false;
        }
        const bucket = this.mqcCarBucket(point, pair.behavior);
        if (bucket && !bucket.police('input', bytes)) {
          this.countMqc(point, pair, bytes, false);
          return false;
        }
        this.applyMqcRemark(pair.behavior, frame);
        this.countMqc(point, pair, bytes, true);
        return true;
      }
    }
    return true;
  }

  private mqcVlanPermits(vlan: number, frame: EthernetFrame): boolean {
    const policyName = this.vlanTrafficPolicies.get(vlan);
    if (!policyName) return true;
    return this.mqcPolicyPermits(policyName, vlan, frame, `vlan${vlan}`);
  }

  private mqcPortPermits(portName: string, vlan: number, frame: EthernetFrame): boolean {
    const policyName = this.portTrafficPolicies.get(portName);
    if (!policyName) return true;
    return this.mqcPolicyPermits(policyName, vlan, frame, portName);
  }

  applyPortTrafficPolicy(portName: string, policyName: string): { ok: boolean; error?: string } {
    if (!this.mqcPolicies.has(policyName)) {
      return { ok: false, error: `Traffic policy ${policyName} does not exist` };
    }
    this.portTrafficPolicies.set(portName, policyName);
    return { ok: true };
  }

  removePortTrafficPolicy(portName: string): void {
    this.portTrafficPolicies.delete(portName);
  }

  getPortTrafficPolicy(portName: string): string | undefined {
    return this.portTrafficPolicies.get(portName);
  }

  setTrunkNativeVlan(portName: string, vlanId: number): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    cfg.trunkNativeVlan = vlanId;
    return true;
  }

  setTrunkAllowedVlans(portName: string, vlans: Set<number> | VlanSet): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    cfg.trunkAllowedVlans = VlanSet.from(vlans);
    return true;
  }

  addTrunkAllowedVlan(portName: string, vlanId: number): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    cfg.trunkAllowedVlans.add(vlanId);
    return true;
  }

  addTrunkAllowedVlans(portName: string, vlans: Set<number>): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    for (const v of vlans) cfg.trunkAllowedVlans.add(v);
    return true;
  }

  removeTrunkAllowedVlan(portName: string, vlanId: number): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    cfg.trunkAllowedVlans.delete(vlanId);
    return true;
  }

  removeTrunkAllowedVlans(portName: string, vlans: Set<number>): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    for (const v of vlans) cfg.trunkAllowedVlans.delete(v);
    return true;
  }

  setTrunkAllowedVlansAll(portName: string): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    cfg.trunkAllowedVlans = VlanSet.all();
    return true;
  }

  setTrunkAllowedVlansNone(portName: string): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    cfg.trunkAllowedVlans = VlanSet.none();
    return true;
  }

  setTrunkAllowedVlansExcept(portName: string, vlans: Set<number>): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    cfg.trunkAllowedVlans = VlanSet.allExcept(vlans);
    return true;
  }

  // ─── STP API ──────────────────────────────────────────────────────

  getSTPState(portName: string): STPPortState {
    return this.stpStates.get(portName) || 'disabled';
  }

  getStpPortVlans(portName: string): number[] {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return [1];
    if (cfg.mode === 'access') {
      return this.vlans.has(cfg.accessVlan) ? [cfg.accessVlan] : [1];
    }
    if (cfg.mode === 'dot1q-tunnel') {
      // A tunneled STP port has no local spanning-tree participation of its
      // own — client BPDUs are opaque relayed data, not real protocol input.
      if (cfg.l2ptProtocols?.has('stp')) return [];
      return this.vlans.has(cfg.accessVlan) ? [cfg.accessVlan] : [1];
    }
    const out = [...this.vlans.keys()]
      .filter((v) => cfg.trunkAllowedVlans.has(v))
      .sort((a, b) => a - b);
    return out.length ? out : [1];
  }

  getStpVlanState(portName: string, vlan: number): STPPortState {
    return this.stpVlanStates.get(`${vlan}:${portName}`) ?? this.getSTPState(portName);
  }

  setStpVlanState(portName: string, vlan: number, state: STPPortState): void {
    this.stpVlanStates.set(`${vlan}:${portName}`, state);
    if (vlan === 1) this.setSTPState(portName, state);
  }

  setSTPState(portName: string, state: STPPortState): void {
    this.stpStates.set(portName, state);
  }

  /** Advance STP timer for a port: listening→learning→forwarding */
  advanceSTPTimer(portName: string): void {
    const current = this.stpStates.get(portName);
    if (current === 'listening') {
      this.stpStates.set(portName, 'learning');
    } else if (current === 'learning') {
      this.stpStates.set(portName, 'forwarding');
    }
  }

  /** Set all ports to the given STP state */
  setAllPortsSTPState(state: STPPortState): void {
    for (const portName of this.stpStates.keys()) {
      this.stpStates.set(portName, state);
    }
  }

  // ─── MAC Move Detection API ───────────────────────────────────

  getMACMoveCount(): number {
    return this.macMoveCount;
  }

  // ─── Port VLAN State API ──────────────────────────────────────

  getPortVlanState(portName: string): 'active' | 'suspended' {
    return this.portVlanStates.get(portName) || 'active';
  }

  // ─── Interface Description API ────────────────────────────────

  setInterfaceDescription(portName: string, desc: string): void {
    this.interfaceDescriptions.set(portName, desc);
  }

  getInterfaceDescription(portName: string): string | undefined {
    return this.interfaceDescriptions.get(portName);
  }

  // ─── MAC Table API ────────────────────────────────────────────────

  getMACTable(): MACTableEntry[] {
    return Array.from(this.macTable.values());
  }

  getMACTableRaw(): Map<string, MACTableEntry> {
    return new Map(this.macTable);
  }

  clearMACTable(): void {
    this.macTable.clear();
    this.getBus().publish({
      topic: 'switch.mac.cleared',
      payload: { deviceId: this.id, hostname: this.getHostname() },
    });
  }

  clearDynamicMACEntries(filter?: { vlan?: number; port?: string }): void {
    for (const [key, entry] of this.macTable) {
      if (entry.type !== 'dynamic') continue;
      if (filter?.vlan !== undefined && entry.vlan !== filter.vlan) continue;
      if (filter?.port !== undefined && entry.port !== filter.port) continue;
      this.macTable.delete(key);
    }
    this.getBus().publish({
      topic: 'switch.mac.cleared',
      payload: { deviceId: this.id, hostname: this.getHostname() },
    });
  }

  /** Purge dynamic entries learned on a port (link-down, err-disable,
   *  802.1X de-authorization). */
  protected flushDynamicMacsOnPort(portName: string, reason: string): void {
    let flushed = 0;
    for (const [key, entry] of this.macTable) {
      if (entry.port === portName && entry.type === 'dynamic') {
        this.macTable.delete(key);
        flushed++;
      }
    }
    if (flushed === 0) return;
    Logger.debug(this.id, 'switch:mac-flush',
      `${this.name}: flushed ${flushed} dynamic MAC(s) on ${portName} (${reason})`);
    this.getBus().publish({
      topic: 'switch.mac.flushed',
      payload: {
        deviceId: this.id, hostname: this.getHostname(),
        port: portName, reason, count: flushed,
      },
    });
  }

  getMACAgingTime(): number {
    return this.macAgingTime;
  }

  setMACAgingTime(seconds: number): void {
    this.macAgingTime = seconds;
  }

  /** STP hook: enable fast aging during a topology change, null restores. */
  _setStpFastAging(agingSec: number | null): void {
    this.stpFastAgingTime = agingSec;
  }

  /** Aging limit in effect (fast aging wins while a TC circulates). */
  private effectiveMacAgingTime(): number {
    return this.stpFastAgingTime ?? this.macAgingTime;
  }

  /**
   * Retire une entrée statique. Seules les statiques partent : `no mac
   * address-table static` ne doit pas effacer ce que le switch a appris
   * tout seul sur la même adresse.
   */
  removeStaticMAC(mac: string, vlan: number): boolean {
    const key = `${vlan}:${mac.toLowerCase()}`;
    const entry = this.macTable.get(key);
    if (!entry || entry.type !== 'static') return false;
    return this.macTable.delete(key);
  }

  addStaticMAC(mac: string, vlan: number, port: string): boolean {
    const key = `${vlan}:${mac.toLowerCase()}`;
    this.macTable.set(key, {
      mac: mac.toLowerCase(),
      vlan,
      port,
      type: 'static',
      age: -1,
      timestamp: Date.now(),
    });
    return true;
  }

  setPortMacLearning(port: string, enabled: boolean, action: MacLearningAction = 'forward'): void {
    if (enabled) this.macLearningPorts.delete(port);
    else this.macLearningPorts.set(port, action);
  }

  setVlanMacLearning(vlan: number, enabled: boolean, action: MacLearningAction = 'forward'): void {
    if (enabled) this.macLearningVlans.delete(vlan);
    else this.macLearningVlans.set(vlan, action);
  }

  getMacLearningDisabledPorts(): [string, MacLearningAction][] {
    return [...this.macLearningPorts].sort((a, b) => a[0].localeCompare(b[0]));
  }

  getMacLearningDisabledVlans(): [number, MacLearningAction][] {
    return [...this.macLearningVlans].sort((a, b) => a[0] - b[0]);
  }

  isMacLearningEnabled(port: string, vlan: number): boolean {
    return !this.macLearningPorts.has(port) && !this.macLearningVlans.has(vlan);
  }

  macLearningAction(port: string, vlan: number): MacLearningAction {
    if (this.macLearningPorts.get(port) === 'discard') return 'discard';
    if (this.macLearningVlans.get(vlan) === 'discard') return 'discard';
    return 'forward';
  }

  addBlackholeMAC(mac: string, vlan: number): boolean {
    const key = `${vlan}:${mac.toLowerCase()}`;
    this.macTable.set(key, {
      mac: mac.toLowerCase(),
      vlan,
      port: '',
      type: 'blackhole',
      age: -1,
      timestamp: Date.now(),
    });
    return true;
  }

  removeBlackholeMAC(mac: string, vlan: number): boolean {
    const key = `${vlan}:${mac.toLowerCase()}`;
    if (this.macTable.get(key)?.type !== 'blackhole') return false;
    return this.macTable.delete(key);
  }

  isBlackholedMAC(mac: string, vlan: number): boolean {
    return this.macTable.get(`${vlan}:${mac.toLowerCase()}`)?.type === 'blackhole';
  }

  // ─── Frame Handling Pipeline ──────────────────────────────────────

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    if (!this.isPoweredOn) return;

    // Port shutdown check
    const port = this.getPort(portName);
    if (port && !port.getIsUp()) return;

    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return;

    // SPAN ingress copy must happen before any DAI/STP/VLAN drop.
    this.mirrorIngress(portName, frame);

    // ─── Port ACL (Huawei `traffic-filter inbound`) ─────────────
    if (!this.portAclPermits(portName, 'in', frame)) {
      Logger.debug(this.id, 'switch:port-acl-drop',
        `${this.name}: inbound ACL dropped frame on ${portName}`);
      return;
    }

    if (!this.policeIngress(portName, frame)) return;

    const taggedFrame = frame as TaggedEthernetFrame;

    // ─── Step 1: Determine ingress VLAN ─────────────────────────
    let ingressVlan: number;

    if (cfg.mode === 'access') {
      if (cfg.voiceVlan !== undefined && taggedFrame.dot1q && taggedFrame.dot1q.vid === cfg.voiceVlan) {
        ingressVlan = cfg.voiceVlan;
      } else if (cfg.voiceVlan !== undefined && cfg.voiceVlanAutoOui && !taggedFrame.dot1q
        && this.matchesVoiceVlanOui(frame.srcMAC)) {
        ingressVlan = cfg.voiceVlan;
      } else {
        ingressVlan = cfg.accessVlan;
      }
    } else if (cfg.mode === 'dot1q-tunnel') {
      // Customer-facing QinQ port: any client tag is opaque payload, never
      // switch VLAN membership — only consulted to pick the S-VLAN when a
      // selective vlan-mapping rule exists for it, else the port's own
      // access VLAN (uniform encapsulation, Phase 3 behaviour).
      const cvlan = taggedFrame.dot1q?.vid;
      const mapped = cvlan !== undefined ? cfg.vlanMapping?.get(cvlan) : undefined;
      ingressVlan = mapped ?? cfg.accessVlan;
    } else if (cfg.mode === 'hybrid') {
      if (taggedFrame.dot1q && taggedFrame.dot1q.vid !== 0) {
        ingressVlan = taggedFrame.dot1q.vid;
        const member = (cfg.hybridTaggedVlans?.has(ingressVlan) ?? false)
          || (cfg.hybridUntaggedVlans?.has(ingressVlan) ?? false);
        if (!member) {
          Logger.debug(this.id, 'switch:hybrid-filtered', `${this.name}: VLAN ${ingressVlan} not allowed on hybrid ${portName}`);
          return;
        }
      } else {
        ingressVlan = cfg.hybridPvid ?? 1;
      }
    } else {
      // Trunk mode — a QinQ outer S-VLAN tag, if present, is what the
      // switch classifies on; any inner customer tag is opaque payload.
      if (taggedFrame.outerDot1q && taggedFrame.outerDot1q.vid !== 0) {
        ingressVlan = taggedFrame.outerDot1q.vid;
        if (!cfg.trunkAllowedVlans.has(ingressVlan)) {
          Logger.debug(this.id, 'switch:trunk-filtered', `${this.name}: VLAN ${ingressVlan} not allowed on trunk ${portName}`);
          return;
        }
      } else if (taggedFrame.dot1q && taggedFrame.dot1q.vid !== 0) {
        ingressVlan = taggedFrame.dot1q.vid;
        if (!cfg.trunkAllowedVlans.has(ingressVlan)) {
          Logger.debug(this.id, 'switch:trunk-filtered', `${this.name}: VLAN ${ingressVlan} not allowed on trunk ${portName}`);
          return;
        }
      } else {
        ingressVlan = cfg.trunkNativeVlan;
      }
    }

    const stpState = this.getStpVlanState(portName, ingressVlan);
    if (stpState === 'blocking' || stpState === 'disabled' || stpState === 'listening') {
      Logger.debug(this.id, 'switch:stp-drop', `${this.name}: dropping frame on ${portName} VLAN ${ingressVlan} (${stpState})`);
      return;
    }

    const ingressCos = this.classifyIngressCos(cfg, frame, ingressVlan);
    const isQinQ = cfg.mode === 'dot1q-tunnel' || !!taggedFrame.outerDot1q;

    // ─── Step 1.5: Dynamic ARP Inspection (untrusted / DAI-enabled VLANs)
    if (frame.etherType === ETHERTYPE_ARP && this.arpInspectionPipeline) {
      const arp = frame.payload as ARPPacket;
      if (arp && arp.type === 'arp') {
        const passed = this.arpInspectionPipeline.process({
          ingressPort: portName,
          vlan: ingressVlan,
          senderIp: arp.senderIP,
          senderMac: arp.senderMAC,
          targetIp: arp.targetIP,
          targetMac: arp.targetMAC,
          ethSrcMac: frame.srcMAC,
          ethDstMac: frame.dstMAC,
          operation: arp.operation,
        });
        if (!passed) return;
        this.snoopLearnArp(arp, portName, ingressVlan);
      }
    }

    // ─── Step 1.5b: DHCP snooping binding learning, driven by the DHCP
    // frames this switch forwards (ACK installs, RELEASE removes).
    if (this.dhcpSnooping.enabled
        && (this.dhcpSnooping.vlans.size === 0 || this.dhcpSnooping.vlans.has(ingressVlan))
        && frame.etherType === ETHERTYPE_IPV4) {
      const ipPkt = frame.payload as IPv4Packet | undefined;
      if (ipPkt && ipPkt.type === 'ipv4' && ipPkt.protocol === IP_PROTO_UDP) {
        const udpPkt = ipPkt.payload as UDPPacket | undefined;
        if (udpPkt && udpPkt.type === 'udp' && udpPkt.payload instanceof DHCPPacket) {
          const dhcpPkt = udpPkt.payload;
          const t = dhcpPkt.getMessageType();
          if (udpPkt.sourcePort === 67 && t === 'DHCPACK' && dhcpPkt.yiaddr !== '0.0.0.0') {
            const lease = Number(dhcpPkt.getOption(51) ?? 86400);
            this.tryRecordSnoopingBinding(dhcpPkt.chaddr, dhcpPkt.yiaddr, Number.isFinite(lease) ? lease : 86400, 5);
          }
          if (udpPkt.sourcePort === 68 && t === 'DHCPRELEASE' && dhcpPkt.ciaddr !== '0.0.0.0') {
            this.removeSnoopingBindingByIp(dhcpPkt.ciaddr);
          }
        }
      }
    }

    // ─── Step 1.6: DHCP Snooping (untrusted ports: rate limit, verify-mac, drop server replies)
    if (this.dhcpSnooping.enabled
        && (this.dhcpSnooping.vlans.size === 0 || this.dhcpSnooping.vlans.has(ingressVlan))
        && !this.dhcpSnooping.trustedPorts.has(portName)
        && frame.etherType === ETHERTYPE_IPV4) {
      const ip = frame.payload as IPv4Packet | undefined;
      if (ip && ip.type === 'ipv4' && ip.protocol === IP_PROTO_UDP) {
        const udp = ip.payload as UDPPacket | undefined;
        if (udp && udp.type === 'udp' && (udp.sourcePort === 67 || udp.sourcePort === 68)) {
          const dhcp = udp.payload;
          const msgType = dhcp instanceof DHCPPacket ? dhcp.getMessageType() : undefined;

          const limit = this.dhcpSnooping.rateLimits.get(portName);
          if (limit && limit > 0) {
            const r = this.dhcpSnoopingRateLimiter.consume(portName, limit, 1);
            if (r.ok === false) {
              this.dhcpSnoopingViolations++;
              this.dhcpSnoopingDroppedRateLimit++;
              this.snoopingLog.push(
                `DHCP_SNOOPING: rate limit (${r.limit} pps) exceeded on ${portName} VLAN ${ingressVlan}, dropped ${msgType ?? 'message'}`,
              );
              Logger.warn(this.id, 'switch:dhcp-snooping-rate-limit',
                `${this.name}: DHCP rate limit exceeded on ${portName} (VLAN ${ingressVlan}) — dropped`);
              return;
            }
          }

          if (udp.sourcePort === 68 && this.dhcpSnooping.verifyMac
              && dhcp instanceof DHCPPacket
              && dhcp.chaddr.toLowerCase() !== frame.srcMAC.toString().toLowerCase()) {
            this.dhcpSnoopingViolations++;
            this.dhcpSnoopingDroppedVerifyMac++;
            this.snoopingLog.push(
              `DHCP_SNOOPING: verify mac-address failed — chaddr ${dhcp.chaddr} != source MAC ${frame.srcMAC} ` +
              `on untrusted port ${portName} VLAN ${ingressVlan}`,
            );
            Logger.warn(this.id, 'switch:dhcp-snooping-mac-mismatch',
              `${this.name}: dropped DHCP client message (chaddr ${dhcp.chaddr} != source MAC ${frame.srcMAC}) ` +
              `on untrusted ${portName} (VLAN ${ingressVlan})`);
            return;
          }

          if (udp.sourcePort === 67) {
            this.dhcpSnoopingViolations++;
            this.dhcpSnoopingDroppedUntrusted++;
            this.snoopingLog.push(
              `DHCP_SNOOPING: dropped ${msgType ?? 'server message'} from ${frame.srcMAC} ` +
              `on untrusted port ${portName} VLAN ${ingressVlan}`,
            );
            Logger.warn(this.id, 'switch:dhcp-snooping-drop',
              `${this.name}: dropped DHCP server message (${msgType ?? 'unknown'}) from ` +
              `${frame.srcMAC} on untrusted ${portName} (VLAN ${ingressVlan})`);
            return;
          }
          this.dhcpSnoopingForwarded++;
        }
      }
    }

    // ─── Step 2: MAC Learning (allowed in learning + forwarding) ─
    const srcMAC = frame.srcMAC.toString().toLowerCase();
    const macKey = `${ingressVlan}:${srcMAC}`;
    const existing = this.macTable.get(macKey);

    if (existing?.type === 'blackhole') {
      Logger.debug(this.id, 'switch:mac-blackhole',
        `${this.name}: dropped frame from ${srcMAC} VLAN ${ingressVlan} (blackhole source)`);
      return;
    }

    if (!this.isMacLearningEnabled(portName, ingressVlan)) {
      if (!existing && this.macLearningAction(portName, ingressVlan) === 'discard') {
        Logger.debug(this.id, 'switch:mac-learning-disabled',
          `${this.name}: dropped frame from unknown ${srcMAC} VLAN ${ingressVlan} on ${portName} (learning disabled, action discard)`);
        this.getBus().publish({
          topic: 'switch.mac.learning-discard',
          payload: {
            deviceId: this.id, hostname: this.getHostname(),
            mac: srcMAC.toString(), vlan: ingressVlan, port: portName,
          },
        });
        return;
      }
    } else if (!existing || existing.type === 'dynamic') {
      // MAC move detection: if MAC exists on a different port
      if (existing && existing.type === 'dynamic' && existing.port !== portName) {
        this.macMoveCount++;
        Logger.warn(this.id, 'switch:mac-move',
          `${this.name}: MAC ${srcMAC} moved from ${existing.port} to ${portName} (VLAN ${ingressVlan})`);
      }
      const isNew = !existing;
      this.macTable.set(macKey, {
        mac: srcMAC,
        vlan: ingressVlan,
        port: portName,
        type: 'dynamic',
        age: this.macAgingTime,
        timestamp: Date.now(),
      });
      Logger.debug(this.id, 'switch:mac-learn', `${this.name}: learned ${srcMAC} VLAN ${ingressVlan} on ${portName}`);
      if (isNew) {
        this.getBus().publish({
          topic: 'switch.mac.learned',
          payload: { deviceId: this.id, hostname: this.getHostname(), mac: srcMAC.toString(), vlan: ingressVlan, port: portName },
        });
      } else if (existing.port !== portName) {
        this.getBus().publish({
          topic: 'switch.mac.moved',
          payload: { deviceId: this.id, hostname: this.getHostname(), mac: srcMAC.toString(), vlan: ingressVlan, port: portName, fromPort: existing.port },
        });
      }
    }

    // ─── Step 2.5: Management plane (SVI) intercept ─────────────
    // A frame addressed to one of our SVIs is consumed here (the box is the
    // destination, not a transit bridge). Broadcast ARP for an SVI is answered
    // but still allowed to flood, so `intercept` returns false for it.
    if (this.svi.intercept(this.resolveSviTarget(ingressVlan), portName, frame)) {
      return;
    }
    // ─── Step 2.6: VRRP advertisement snoop (RFC 5798) ─────────
    // Multicast VRRP packets on 224.0.0.18 must reach the local
    // agent whichever Vlanif they arrived on, so the RFC state
    // machine on both switches sees the peer and one of them
    // stays Master while the other becomes Backup. The frame keeps
    // flooding the VLAN normally afterwards.
    if ((this._vrrpAgent || this._hsrpAgent || this._glbpAgent) && frame.etherType === ETHERTYPE_IPV4) {
      const ip = frame.payload as IPv4Packet | undefined;
      if (ip && ip.type === 'ipv4') {
        if (ip.protocol === IP_PROTO_VRRP && this._vrrpAgent) {
          this._vrrpAgent.handleIp(`Vlanif${ingressVlan}`, ip.sourceIP, ip);
        }
        if (ip.protocol === IP_PROTO_UDP) {
          const udp = ip.payload as UDPPacket | undefined;
          if (udp && udp.type === 'udp') {
            if (udp.destinationPort === UDP_PORT_HSRP && this._hsrpAgent) {
              this._hsrpAgent.handleUdp(`Vlanif${ingressVlan}`, ip.sourceIP, udp);
            }
            if (udp.destinationPort === UDP_PORT_GLBP && this._glbpAgent) {
              this._glbpAgent.handleUdp(`Vlanif${ingressVlan}`, ip.sourceIP, udp);
            }
          }
        }
      }
    }

    // ─── Step 2.7: VLAN-scoped filtering (Cisco VACL / Huawei MQC) ─
    if (!this.vaclPermits(ingressVlan, frame)
      || !this.mqcVlanPermits(ingressVlan, frame)
      || !this.mqcPortPermits(portName, ingressVlan, frame)) {
      Logger.debug(this.id, 'switch:vacl-drop',
        `${this.name}: VLAN filter dropped frame on ${portName} VLAN ${ingressVlan}`);
      return;
    }

    // ─── Step 3: Forwarding Decision ────────────────────────────
    // In learning state: learn MACs but do NOT forward frames
    if (stpState === 'learning') {
      return;
    }

    const dstMAC = frame.dstMAC.toString().toLowerCase();

    // IEEE 802.3 §3.2.3 — the I/G bit (LSB of the first octet) marks
    // ANY group address: IPv4 multicast 01:00:5e, IPv6 33:33, protocol
    // MACs 01:80:c2/01:00:0c, … Group frames are never unicast-matched
    // against the MAC table; they are snooped or flooded.
    const isMulticast = isGroupAddress(frame.dstMAC);

    if (!isMulticast && this.macTable.get(`${ingressVlan}:${dstMAC}`)?.type === 'blackhole') {
      Logger.debug(this.id, 'switch:mac-blackhole',
        `${this.name}: dropped frame to ${dstMAC} VLAN ${ingressVlan} (blackhole destination)`);
      return;
    }

    if (isMulticast || !this.macTable.has(`${ingressVlan}:${dstMAC}`)) {
      const snoopedPorts = isMulticast ? this.resolveSnoopedMulticastEgressPorts(portName, frame, ingressVlan) : null;
      if (snoopedPorts) {
        Logger.debug(
          this.id, 'switch:igmp-snoop-forward',
          `${this.name}: snooped multicast ${dstMAC} VLAN ${ingressVlan} → [${snoopedPorts.join(', ')}] (ingress ${portName})`,
          { dstMAC: dstMAC.toString(), srcMAC: srcMAC.toString(), vlan: ingressVlan, ingress: portName, egress: snoopedPorts },
        );
        for (const egressPort of snoopedPorts) this.forwardToPort(egressPort, frame, ingressVlan, portName, ingressCos, isQinQ);
        return;
      }
      Logger.debug(
        this.id, 'switch:flood',
        `${this.name}: flood ${dstMAC} VLAN ${ingressVlan} (ingress ${portName})`,
        { dstMAC: dstMAC.toString(), srcMAC: srcMAC.toString(), vlan: ingressVlan, ingress: portName, reason: isMulticast ? 'multicast' : 'unknown-unicast' },
      );
      this.floodFrame(portName, frame, ingressVlan, ingressCos, isQinQ);
    } else {
      const dstEntry = this.macTable.get(`${ingressVlan}:${dstMAC}`)!;
      if (dstEntry.port !== portName) {
        Logger.debug(
          this.id, 'switch:forward',
          `${this.name}: forward ${dstMAC} VLAN ${ingressVlan} ${portName} → ${dstEntry.port}`,
          { dstMAC: dstMAC.toString(), srcMAC: srcMAC.toString(), vlan: ingressVlan, ingress: portName, egress: dstEntry.port },
        );
        this.forwardToPort(dstEntry.port, frame, ingressVlan, portName, ingressCos, isQinQ);
      }
    }
  }

  /**
   * IGMP-snooping constrained forwarding (RFC 4541 §2.1.2): when a
   * snooping agent is present and enabled on the VLAN, an IPv4
   * multicast frame egresses only the member/router ports. Vendors
   * supply their agent via {@link getIgmpSnoopingAgentOrNull}; the
   * pipeline itself is vendor-neutral and lives here once.
   */
  protected resolveSnoopedMulticastEgressPorts(ingressPort: string, frame: EthernetFrame, vlan: number): string[] | null {
    if (frame.etherType !== ETHERTYPE_IPV4) return null;
    const ipPkt = frame.payload as IPv4Packet | undefined;
    if (!ipPkt || ipPkt.type !== 'ipv4' || !(ipPkt.destinationIP instanceof IPAddress)) return null;
    if (classifyIpv4Destination(ipPkt.destinationIP) !== 'multicast') return null;

    // Both snooping engines answer for the same group; the frame egresses
    // the union of what each one learned. Composing them here — rather
    // than teaching either engine about the other — keeps each one's own
    // member ∪ router-port merge as the single implementation of it.
    const group = ipPkt.destinationIP.toString();
    const ports = new Set<string>();
    let anyActive = false;

    const igmp = this.getIgmpSnoopingAgentOrNull();
    if (igmp?.getVlanState(vlan)?.enabled) {
      anyActive = true;
      for (const p of igmp.computeEgressPorts(ingressPort, group)) ports.add(p);
    }

    const pim = this.getPimSnoopingAgentOrNull();
    if (pim?.getConfig().enabled && pim.getVlanState(vlan)?.enabled) {
      anyActive = true;
      for (const p of pim.computeEgressPorts(ingressPort, group)) ports.add(p);
    }

    if (!anyActive || ports.size === 0) return null;
    return Array.from(ports);
  }

  /** Vendor hook: the IGMP-snooping agent, when the platform has one. */
  protected getIgmpSnoopingAgentOrNull(): IgmpSnoopingAgentLike | null {
    return null;
  }

  /** Vendor hook: the PIM-snooping agent, when the platform has one. */
  protected getPimSnoopingAgentOrNull(): PimSnoopingAgentLike | null {
    return null;
  }

  /** Vendor hook: the VTP agent, when the platform has one (Cisco only). */
  protected getVtpAgentOrNull(): VtpPruningAgentLike | null {
    return null;
  }

  /** Vendor hook: voice VLAN OUI auto-detection (Huawei only). */
  protected matchesVoiceVlanOui(_mac: MACAddress): boolean {
    return false;
  }

  /** IP TOS byte's DSCP field mapped down to a 3-bit CoS (top 3 DSCP bits). */
  private frameDscpCos(frame: EthernetFrame): number | null {
    if (frame.etherType !== ETHERTYPE_IPV4) return null;
    const ip = frame.payload as IPv4Packet | undefined;
    if (!ip || ip.type !== 'ipv4' || typeof ip.tos !== 'number') return null;
    return ((ip.tos >> 2) & 0x3f) >> 3;
  }

  /**
   * 802.1p classification at ingress: applies the port's trust boundary
   * (`mls qos trust`/`qos trust`) and default CoS, with the voice-VLAN
   * `priority extend` override for downstream PC traffic passed through an
   * IP phone (Cisco `switchport priority extend cos <n>`, Huawei
   * `trust upstream`'s fixed-remark counterpart).
   */
  private classifyIngressCos(cfg: SwitchportConfig, frame: EthernetFrame, ingressVlan: number): number {
    const fallback = cfg.defaultCos ?? 0;
    const isPhoneDataPort = cfg.voiceVlan !== undefined && ingressVlan !== cfg.voiceVlan
      && (cfg.mode === 'access' || cfg.mode === 'hybrid');
    if (isPhoneDataPort && cfg.priorityExtend?.mode === 'cos') return cfg.priorityExtend.value & 7;

    const trust = cfg.trustMode ?? 'untrusted';
    const tagged = frame as TaggedEthernetFrame;
    if (trust === 'cos' && tagged.dot1q) return tagged.dot1q.pcp & 7;
    if (trust === 'dscp') return this.frameDscpCos(frame) ?? fallback;
    return fallback;
  }

  /** Every S-VLAN this dot1q-tunnel port can egress on: its default `accessVlan` plus any selective vlan-mapping targets. */
  private dot1qTunnelServesVlan(cfg: SwitchportConfig, vlan: number): boolean {
    if (cfg.accessVlan === vlan) return true;
    if (!cfg.vlanMapping) return false;
    for (const svlan of cfg.vlanMapping.values()) {
      if (svlan === vlan) return true;
    }
    return false;
  }

  // ─── Flood within VLAN ────────────────────────────────────────────

  protected aggregationEgressPort(
    portName: string, _frame: EthernetFrame, _ingressPort?: string,
  ): string | null {
    return portName;
  }

  private floodFrame(exceptPort: string, frame: EthernetFrame, vlan: number, cos: number = 0, isQinQ: boolean = false): void {
    for (const [portName, cfg] of this.switchportConfigs) {
      if (portName === exceptPort) continue;
      if (this.aggregationEgressPort(portName, frame, exceptPort) !== portName) continue;

      const port = this.getPort(portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;

      const stpState = this.getStpVlanState(portName, vlan);
      if (stpState === 'blocking' || stpState === 'disabled' || stpState === 'listening' || stpState === 'learning') continue;

      if (cfg.mode === 'access') {
        if (this.resolvePvlanPrimary(vlan) !== undefined) {
          if (this.pvlanEgressAllowed(exceptPort, portName, vlan)) {
            this.sendFrame(portName, this.stripTag(frame));
          }
        } else if (cfg.accessVlan === vlan) {
          if (!this.portIsolateBlocks(exceptPort, portName)) {
            this.sendFrame(portName, this.stripTag(frame));
          }
        } else if (!exceptPort && this.superVlanReaches(vlan, cfg.accessVlan)) {
          this.sendFrame(portName, this.stripTag(frame));
        } else if (cfg.voiceVlan === vlan) {
          this.sendFrame(portName, this.addTag(frame, vlan, cos));
        }
      } else if (cfg.mode === 'dot1q-tunnel') {
        if (this.dot1qTunnelServesVlan(cfg, vlan)) {
          this.sendFrame(portName, this.stripOuterTag(frame));
        }
      } else if (cfg.mode === 'hybrid') {
        if (cfg.hybridUntaggedVlans?.has(vlan)) {
          this.sendFrame(portName, this.stripTag(frame));
        } else if (cfg.hybridTaggedVlans?.has(vlan)) {
          this.sendFrame(portName, this.addTag(frame, vlan, cos));
        }
      } else {
        // Trunk: send if VLAN is allowed
        if (cfg.trunkAllowedVlans.has(vlan) && !this.getVtpAgentOrNull()?.isVlanPruned(portName, vlan)) {
          const pv = this.pvlanPorts.get(portName);
          if (pv && this.resolvePvlanPrimary(vlan) !== undefined) {
            if (!this.pvlanEgressAllowed(exceptPort, portName, vlan)) continue;
            const outVlan = this.pvlanTrunkEgressVlan(pv, vlan);
            this.sendFrame(portName, outVlan === cfg.trunkNativeVlan
              ? this.stripTag(frame) : this.addTag(frame, outVlan, cos));
            continue;
          }
          if (vlan === cfg.trunkNativeVlan) {
            // Native VLAN: send untagged
            this.sendFrame(portName, isQinQ ? this.stripOuterTag(frame) : this.stripTag(frame));
          } else {
            // Non-native: send tagged
            this.sendFrame(portName, isQinQ ? this.addOuterTag(frame, vlan, cos) : this.addTag(frame, vlan, cos));
          }
        }
      }
    }
  }

  // ─── Forward to Specific Port ─────────────────────────────────────

  private forwardToPort(nominalPort: string, frame: EthernetFrame, vlan: number, ingressPort?: string, cos: number = 0, isQinQ: boolean = false): void {
    const portName = this.aggregationEgressPort(nominalPort, frame, ingressPort) ?? nominalPort;
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return;

    const port = this.getPort(portName);
    if (!port || !port.getIsUp()) return;

    // ─── Port ACL (Huawei `traffic-filter outbound`) ────────────
    if (!this.portAclPermits(portName, 'out', frame)) return;

    const stpState = this.getStpVlanState(portName, vlan);
    if (stpState === 'blocking' || stpState === 'disabled' || stpState === 'listening' || stpState === 'learning') return;

    if (cfg.mode === 'access') {
      if (ingressPort !== undefined && !this.pvlanEgressAllowed(ingressPort, portName, vlan)) return;
      if (ingressPort !== undefined && this.portIsolateBlocks(ingressPort, portName)) return;
      if (cfg.voiceVlan === vlan) {
        this.sendFrame(portName, this.addTag(frame, vlan, cos));
      } else {
        this.sendFrame(portName, this.stripTag(frame));
      }
    } else if (cfg.mode === 'dot1q-tunnel') {
      if (this.dot1qTunnelServesVlan(cfg, vlan)) {
        this.sendFrame(portName, this.stripOuterTag(frame));
      }
    } else if (cfg.mode === 'hybrid') {
      if (cfg.hybridUntaggedVlans?.has(vlan)) {
        this.sendFrame(portName, this.stripTag(frame));
      } else if (cfg.hybridTaggedVlans?.has(vlan)) {
        this.sendFrame(portName, this.addTag(frame, vlan, cos));
      }
    } else {
      // Trunk port: check if VLAN is allowed before sending
      if (!cfg.trunkAllowedVlans.has(vlan)) {
        Logger.debug(this.id, 'switch:trunk-filtered', `${this.name}: VLAN ${vlan} not allowed on trunk ${portName} (egress)`);
        return;
      }
      const pv = this.pvlanPorts.get(portName);
      if (pv && this.resolvePvlanPrimary(vlan) !== undefined) {
        if (ingressPort !== undefined && !this.pvlanEgressAllowed(ingressPort, portName, vlan)) return;
        const outVlan = this.pvlanTrunkEgressVlan(pv, vlan);
        this.sendFrame(portName, outVlan === cfg.trunkNativeVlan
          ? this.stripTag(frame) : this.addTag(frame, outVlan, cos));
        return;
      }
      if (vlan === cfg.trunkNativeVlan) {
        this.sendFrame(portName, isQinQ ? this.stripOuterTag(frame) : this.stripTag(frame));
      } else {
        this.sendFrame(portName, isQinQ ? this.addOuterTag(frame, vlan, cos) : this.addTag(frame, vlan, cos));
      }
    }
  }

  override sendFrame(portName: string, frame: EthernetFrame): boolean {
    if (!this.mirrorReentrant) this.mirrorEgress(portName, frame);
    return super.sendFrame(portName, frame);
  }

  private mirrorIngress(srcPort: string, frame: EthernetFrame): void {
    if (!this.portMirror.hasAny()) return;
    this.emitMirror(this.portMirror.destinationsFor(srcPort, 'rx'), frame);
  }

  private mirrorEgress(srcPort: string, frame: EthernetFrame): void {
    if (!this.portMirror.hasAny()) return;
    this.emitMirror(this.portMirror.destinationsFor(srcPort, 'tx'), frame);
  }

  private emitMirror(dests: readonly string[], frame: EthernetFrame): void {
    if (dests.length === 0) return;
    this.mirrorReentrant = true;
    try {
      for (const dest of dests) {
        const p = this.getPort(dest);
        if (!p || !p.getIsUp() || !p.isConnected()) continue;
        super.sendFrame(dest, { ...frame });
      }
    } finally {
      this.mirrorReentrant = false;
    }
  }

  configureMirrorSource(id: number, portName: string, dir: MirrorDirection): boolean {
    if (!this.getPort(portName)) return false;
    this.portMirror.addSource(id, portName, dir);
    return true;
  }
  configureMirrorDestination(id: number, portName: string): boolean {
    if (!this.getPort(portName)) return false;
    this.portMirror.setDestination(id, portName);
    return true;
  }
  removeMirrorSource(id: number, portName: string): boolean {
    return this.portMirror.removeSource(id, portName);
  }
  removeMirrorDestination(id: number): boolean {
    return this.portMirror.clearDestination(id);
  }
  removeMirrorSession(id: number): boolean {
    return this.portMirror.removeSession(id);
  }
  listMirrorSessions(): MirrorSession[] { return this.portMirror.list(); }
  getMirrorSession(id: number): MirrorSession | undefined { return this.portMirror.get(id); }

  // ─── L3 Management Plane (SVI) plumbing ───────────────────────────

  /** Bridge base MAC — shared by every SVI, like real Catalyst hardware. */
  getBridgeMac(): MACAddress {
    const first = this.getPorts()[0];
    return first ? first.getMAC() : MACAddress.broadcast();
  }

  /** True when `vlan` has at least one up, cabled member port. */
  private vlanHasActivePort(vlan: number): boolean {
    for (const [portName, cfg] of this.switchportConfigs) {
      const port = this.getPort(portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;
      if (cfg.mode === 'access' ? cfg.accessVlan === vlan : cfg.trunkAllowedVlans.has(vlan)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Source a frame from the management plane onto `vlan`: reuse the very same
   * unknown-unicast/flood vs known-unicast decision the data plane makes for
   * transit frames, so an SVI packet leaves exactly like a host's would.
   */
  private egressOnVlan(vlan: number, frame: EthernetFrame): void {
    const dstMAC = frame.dstMAC.toString().toLowerCase();
    const isGroup = isGroupAddress(frame.dstMAC);
    const entry = isGroup ? undefined : this.macTable.get(`${vlan}:${dstMAC}`);
    if (entry) {
      this.forwardToPort(entry.port, frame, vlan);
    } else {
      this.floodFrame('', frame, vlan);
    }
  }

  // ─── SVI configuration API (used by the vendor shell) ─────────────

  /** `interface Vlan N` — materialise the SVI (admin-down, no IP) if new. */
  ensureSvi(vlan: number): void { this.svi.ensure(vlan); }
  private readonly dhcpClientAgent: RouterDhcpClient = new RouterDhcpClient({
    macOf: () => this.getBridgeMac().toString(),
    linkUsable: (iface) => {
      const vlan = Switch.vlanOfSviName(iface);
      return vlan !== null && this.getSvi(vlan)?.adminUp === true
        && this.vlanHasActivePort(vlan);
    },
    applyLease: (iface, ip, mask) => {
      const vlan = Switch.vlanOfSviName(iface);
      if (vlan !== null) this.configureSviIp(vlan, new IPAddress(ip), new SubnetMask(mask));
    },
    clearLease: (iface) => {
      const vlan = Switch.vlanOfSviName(iface);
      if (vlan !== null) this.clearSviIp(vlan);
    },
    markClient: (iface, on) => {
      const vlan = Switch.vlanOfSviName(iface);
      if (vlan === null) return;
      this.ensureSvi(vlan);
      const svi = this.getSvi(vlan);
      if (svi) svi.dhcpClient = on;
    },
    sendDhcpFrame: (iface, pkt) => {
      const vlan = Switch.vlanOfSviName(iface);
      if (vlan === null) return;
      const udp: UDPPacket = {
        type: 'udp', sourcePort: 68, destinationPort: 67,
        length: 8 + 300, checksum: 0, payload: pkt,
      };
      const ipPkt = createIPv4Packet(
        new IPAddress('0.0.0.0'), new IPAddress('255.255.255.255'),
        IP_PROTO_UDP, 64, udp, 8 + 300);
      this.egressOnVlan(vlan, {
        srcMAC: this.getBridgeMac(),
        dstMAC: MACAddress.broadcast(),
        etherType: ETHERTYPE_IPV4,
        payload: ipPkt,
      });
    },
    bus: () => this.getBus(),
    identity: () => ({ deviceId: this.id, hostname: this.getHostname() }),
  });

  getDhcpClientAgent(): RouterDhcpClient { return this.dhcpClientAgent; }

  private sviClientIface(vlan: number): string | null {
    if (!this.getSvi(vlan)?.dhcpClient) return null;
    return this.dhcpClientAgent.enabledInterfaces()
      .find(i => Switch.vlanOfSviName(i) === vlan) ?? null;
  }

  static vlanOfSviName(name: string): number | null {
    const m = name.match(/^(?:Vlanif|Vlan)\s*(\d+)$/i);
    return m ? parseInt(m[1], 10) : null;
  }

  configureSviIp(vlan: number, ip: IPAddress, mask: SubnetMask): void {
    this.svi.configure(vlan, ip, mask);
  }
  clearSviIp(vlan: number): void { this.svi.clearIp(vlan); }
  setSviAdminUp(vlan: number, up: boolean): void {
    this.svi.setAdminUp(vlan, up);
    const clientIface = this.sviClientIface(vlan);
    if (clientIface !== null) {
      if (up) this.dhcpClientAgent.onLinkUp(clientIface);
      else this.dhcpClientAgent.onLinkDown(clientIface);
    }
    // Feed the FHRP link-state signal so any VRRP group on this
    // Vlanif recomputes (Init→Master when the SVI comes up, or the
    // reverse on shutdown). The FhrpAgentBase already subscribes to
    // port.link.up/down filtered on our deviceId.
    const portName = `Vlanif${vlan}`;
    this.getBus().publish({
      topic: up ? 'port.link.up' : 'port.link.down',
      payload: { deviceId: this.id, portName },
    });
  }
  // ─── LoopBack configuration API (used by the vendor shell) ────────

  /** `interface LoopBack N` — matérialise l'interface si elle est neuve. */
  ensureLoopback(name: string): void {
    if (!this.loopbacks.has(name)) this.loopbacks.set(name, { name });
  }

  configureLoopbackIp(name: string, ip: IPAddress, mask: SubnetMask): void {
    const lb = this.loopbacks.get(name) ?? { name };
    lb.ip = ip;
    lb.mask = mask;
    this.loopbacks.set(name, lb);
  }

  clearLoopbackIp(name: string): void {
    const lb = this.loopbacks.get(name);
    if (lb) { lb.ip = undefined; lb.mask = undefined; }
  }

  /** `undo interface LoopBack N` — l'interface disparaît entièrement. */
  removeLoopback(name: string): boolean { return this.loopbacks.delete(name); }

  hasLoopback(name: string): boolean { return this.loopbacks.has(name); }

  getLoopbacks(): Array<{ name: string; ip?: IPAddress; mask?: SubnetMask }> {
    return [...this.loopbacks.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  }

  getLoopback(name: string): { name: string; ip?: IPAddress; mask?: SubnetMask } | undefined {
    return this.loopbacks.get(name);
  }

  hasSvi(vlan: number): boolean { return this.svi.hasSvi(vlan); }
  setIpRoutingEnabled(v: boolean): void { this.ipRoutingEnabled = v; }
  isIpRoutingEnabled(): boolean { return this.ipRoutingEnabled; }
  sendUdpDatagram(
    request: import('../layers/transport/UdpEgress').UdpSendRequest,
  ): boolean {
    return this.svi.sendUdpDatagram(request);
  }

  sendIpv4FrameArpAware(_iface: string, packet: IPv4Packet, nextHop: IPAddress): void {
    this.svi.sendIpv4FrameArpAware(packet, nextHop);
  }

  sourceAddressFor(destination: IPAddress): IPAddress | null {
    if (requiresNamedInterface(destination)) return null;
    return this.svi.sourceAddressFor(destination);
  }

  sendIpv4Packet(request: Ipv4SendRequest): boolean {
    if (!requiresNamedInterface(request.destination)) return false;
    return sendOnNamedInterface({
      getPort: (name) => this.getPort(name),
      sendFrame: (name, frame) => this.sendFrame(name, frame),
    }, request);
  }

  getSvis(): SviInterface[] { return this.svi.list(); }
  getSvi(vlan: number): SviInterface | undefined { return this.svi.getSvi(vlan); }
  isSviLineUp(svi: SviInterface): boolean { return this.svi.isLineUp(svi); }

  /** Append a DHCP relay target on `vlan`'s SVI. */
  addSviHelperAddress(vlan: number, ip: string): void {
    this.svi.addHelperAddress(vlan, ip);
  }
  /** Remove a DHCP relay target from `vlan`'s SVI. */
  removeSviHelperAddress(vlan: number, ip: string): boolean {
    return this.svi.removeHelperAddress(vlan, ip);
  }

  /**
   * Helpers configured for the SVI the given physical port belongs to.
   * Lets a downstream DHCP client follow `ip helper-address` to find
   * its upstream server even when no direct cable path exists.
   */
  getDhcpHelpersForIngressPort(portName: string): string[] {
    const cfg = this._getSwitchportConfigs().get(portName);
    if (!cfg) return [];
    const vlan = cfg.mode === 'trunk' ? cfg.trunkNativeVlan : cfg.accessVlan;
    return this.svi.getSvi(vlan)?.helperAddresses ?? [];
  }

  executePingSequence(
    target: IPAddress, count = 5, timeoutMs = 2000, sourceIPStr?: string,
  ): Promise<CiscoPingRow[]> {
    return this.svi.executePingSequence(target, count, timeoutMs, sourceIPStr);
  }

  getStaticRoutes() { return this.svi.getStaticRoutes(); }

  addStaticRoute(
    network: IPAddress, mask: SubnetMask, nextHop: IPAddress, preference?: number,
  ): void {
    this.svi.addStaticRoute(network, mask, nextHop, preference);
  }
  removeStaticRoute(network: IPAddress, mask: SubnetMask, nextHop?: IPAddress): boolean {
    return this.svi.removeStaticRoute(network, mask, nextHop);
  }
  getL3RoutingTable() {
    return this.svi.getRoutingTable();
  }

  // ─── 802.1Q Tagging Helpers ───────────────────────────────────────

  private addTag(frame: EthernetFrame, vlan: number, cos: number = 0): TaggedEthernetFrame {
    return {
      ...frame,
      dot1q: { tpid: 0x8100, pcp: cos & 7, dei: 0, vid: vlan },
    };
  }

  private stripTag(frame: EthernetFrame): EthernetFrame {
    const tagged = frame as TaggedEthernetFrame;
    if (tagged.dot1q) {
      const { dot1q, ...untagged } = tagged;
      return untagged;
    }
    // Still a fresh top-level object — floodFrame() calls this once per
    // egress port, and sendFrame() hands the returned object all the way
    // to the receiving device's handleFrame(); returning `frame` itself
    // here would alias the very same object across every flooded port.
    return { ...frame };
  }

  /** Push the QinQ S-VLAN outer tag (EtherType 0x88a8); any existing `dot1q` (customer C-VLAN tag) is left untouched underneath it. */
  private addOuterTag(frame: EthernetFrame, vlan: number, cos: number = 0): TaggedEthernetFrame {
    return {
      ...frame,
      outerDot1q: { tpid: 0x88a8, pcp: cos & 7, dei: 0, vid: vlan },
    } as TaggedEthernetFrame;
  }

  /** Symmetric strip of only the QinQ outer S-VLAN tag, restoring the customer frame (with its own `dot1q`, if any, intact). */
  private stripOuterTag(frame: EthernetFrame): EthernetFrame {
    const tagged = frame as TaggedEthernetFrame;
    if (tagged.outerDot1q) {
      const { outerDot1q, ...rest } = tagged;
      return rest;
    }
    return { ...frame };
  }

  // ─── MAC Aging Process ────────────────────────────────────────────

  /** Test-only / multi-topology scheduler injection (Phase 4 of the
   *  reactive refactor). When unset, the default scheduler singleton is
   *  used so existing call sites are unaffected. Setting this after the
   *  switch was constructed restarts the MAC-aging process on the new
   *  scheduler so subsequent `clear()` calls land on the right one. */
  setScheduler(scheduler: IScheduler | null): void {
    if (this.schedulerOverride === scheduler) return;
    const wasRunning = this.macAgingTimer !== null;
    if (wasRunning) this.stopMACAgingProcess();
    this.schedulerOverride = scheduler;
    if (wasRunning) this.startMACAgingProcess();
  }

  protected getScheduler(): IScheduler {
    return this.schedulerOverride ?? getDefaultScheduler();
  }

  private startMACAgingProcess(): void {
    if (this.macAgingTimer !== null) return;
    const scheduler = this.getScheduler();
    this.macAgingScheduler = scheduler;
    this.macAgingTimer = scheduler.setInterval(() => {
      const now = Date.now();
      const limit = this.effectiveMacAgingTime();
      for (const [key, entry] of this.macTable) {
        if (entry.type === 'dynamic') {
          const elapsed = Math.floor((now - entry.timestamp) / 1000);
          entry.age = Math.max(0, limit - elapsed);
          if (entry.age <= 0) {
            this.macTable.delete(key);
            Logger.debug(this.id, 'switch:mac-age', `${this.name}: aged out ${entry.mac} VLAN ${entry.vlan}`);
            this.getBus().publish({
              topic: 'switch.mac.aged',
              payload: { deviceId: this.id, hostname: this.getHostname(), mac: String(entry.mac), vlan: entry.vlan, port: entry.port },
            });
          }
        }
      }
    }, 1000);
  }

  private stopMACAgingProcess(): void {
    if (this.macAgingTimer !== null) {
      // Use the scheduler that *scheduled* the timer, not the current
      // override — they may differ if `setScheduler` was called after
      // the timer was registered.
      const scheduler = this.macAgingScheduler ?? this.getScheduler();
      scheduler.clear(this.macAgingTimer);
      this.macAgingTimer = null;
      this.macAgingScheduler = null;
    }
  }

  // ─── Config Persistence (Running → Startup) ──────────────────────

  getRunningConfig(): string {
    if ('buildRunningConfig' in this.shell) {
      return (this.shell as any).buildRunningConfig(this);
    }
    return '';
  }

  /** The vendor CLI shell (mirror of Router.getShell). */
  getShell(): ISwitchShell { return this.shell; }

  writeMemory(): string {
    // NVRAM holds the rendered running-config TEXT — the same representation
    // `show startup-config` displays and `reload` re-applies. Real IOS stores
    // and re-parses config text; we do the same instead of a private blob.
    this.startupConfig = this.getRunningConfig();
    return '[OK]';
  }

  getStartupConfig(): string | null {
    return this.startupConfig;
  }

  /** @internal Persist rendered config text into NVRAM (VRP `save` path —
   *  mirror of Router._captureStartupConfig). */
  _captureStartupConfig(text: string): void {
    this.startupConfig = text;
  }

  /** @internal Erase NVRAM (`erase startup-config` / `write erase`). */
  _eraseStartupConfig(): void {
    this.startupConfig = null;
  }

  /** @internal Re-apply NVRAM onto the live config (`copy startup-config
   *  running-config`). Returns false when NVRAM is empty. */
  _restoreStartupConfig(): boolean {
    if (!this.startupConfig) return false;
    this.applyConfigText(this.startupConfig);
    return true;
  }

  /** @internal Re-apply an arbitrary saved config text (`copy flash:X
   *  running-config`). */
  _applyConfigText(text: string): void { this.applyConfigText(text); }

  // ── `flash:` / `nvram:` — UN par machine, pas un par session ──────
  private ciscoFs: CiscoFileSystem | null = null;

  /** Le `flash:` de CETTE machine, partagé par toutes ses sessions. */
  _getCiscoFileSystem(
    profile: import('./shells/cisco/CiscoCommonShow').CiscoChassisProfile,
  ): CiscoFileSystem {
    if (!this.ciscoFs) this.ciscoFs = new CiscoFileSystem(profile);
    return this.ciscoFs;
  }

  /** @internal `copy running-config flash:X` — dans le VRAI `flash:`. */
  _writeFlashFile(name: string, content: string): void {
    this._getCiscoFileSystem('switch-c2960').write(name, content);
  }
  /** @internal `copy flash:X running-config` — read it back (null if absent). */
  _readFlashFile(name: string): string | null {
    return this._getCiscoFileSystem('switch-c2960').read(name);
  }
  _listFlashFiles(): readonly string[] {
    return this._getCiscoFileSystem('switch-c2960').list().map((f) => f.name);
  }

  private restoreFromStartupConfig(): void {
    if (this.startupConfig) this.applyConfigText(this.startupConfig);
  }

  /**
   * Re-apply a saved running-config (text) to live switch state. Parses the
   * canonical lines emitted by the vendor shell's `buildRunningConfig` —
   * hostname, VLAN database and per-interface switchport settings — which is
   * exactly the state the previous JSON snapshot restored, but from the single
   * text representation now shared with `show startup-config`.
   */
  private applyConfigText(text: string): void {
    let curVlan: number | null = null;
    let curIface: string | null = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line === '!' ||
          line.startsWith('Building config') || line.startsWith('Current configuration')) continue;
      let g: RegExpMatchArray | null;
      if ((g = line.match(/^hostname\s+(\S+)/))) {
        this.hostname = g[1]; this.name = g[1]; curVlan = null; curIface = null;
      } else if ((g = line.match(/^username\s+(\S+)(.*)$/))) {
        curVlan = null; curIface = null;
        const rest = g[2];
        const pm = rest.match(/privilege\s+(\d+)/);
        const sm = rest.match(/\b(secret|password)\s+(?:(\d)\s+)?(\S+)/);
        let secret: string | undefined;
        let secretAlgo: PasswordHashAlgorithm | undefined;
        if (sm) {
          secret = sm[3];
          const d = sm[2];
          secretAlgo = d === '7' ? 'type-7' : d === '8' ? 'sha256' : d === '9' ? 'scrypt'
            : d === '0' ? 'plain' : (sm[1] === 'secret' ? 'md5' : 'plain');
        }
        this._upsertCiscoUsername(g[1], {
          privilege: pm ? parseInt(pm[1], 10) : undefined, secret, secretAlgo,
        });
      } else if ((g = line.match(/^vlan\s+(\d+)$/))) {
        curVlan = parseInt(g[1], 10); curIface = null;
        if (!this.vlans.has(curVlan)) this.createVLAN(curVlan);
      } else if (curVlan !== null && (g = line.match(/^name\s+(.+)/))) {
        this.renameVLAN(curVlan, g[1]);
      } else if ((g = line.match(/^interface\s+(\S+)/))) {
        curIface = g[1]; curVlan = null;
      } else if (curIface) {
        const cfg = this.switchportConfigs.get(curIface);
        if (!cfg) continue;
        if (/^switchport mode trunk/.test(line)) cfg.mode = 'trunk';
        else if (/^switchport mode access/.test(line)) cfg.mode = 'access';
        else if ((g = line.match(/^switchport access vlan\s+(\d+)/))) cfg.accessVlan = parseInt(g[1], 10);
        else if ((g = line.match(/^switchport trunk native vlan\s+(\d+)/))) cfg.trunkNativeVlan = parseInt(g[1], 10);
        else if (/^shutdown$/.test(line)) { const p = this.getPort(curIface); if (p) p.setAdminShutdown(true); }
      }
    }
    // Rebuild access-VLAN port membership from the restored switchport config.
    for (const [portName, cfg] of this.switchportConfigs) {
      if (cfg.mode === 'access') {
        const vlan = this.vlans.get(cfg.accessVlan);
        if (vlan) vlan.ports.add(portName);
      }
    }
  }

  // ─── Internal Accessors (for Shell) ───────────────────────────────

  /** @internal Used by CiscoSwitchShell */
  _getPortsInternal(): Map<string, Port> { return this.ports; }
  _getHostnameInternal(): string { return this.hostname; }
  _setHostnameInternal(name: string): void {
    this.hostname = name;
    this.name = name;
  }

  defaultHostname(): string { return 'Switch'; }
  _getSwitchportConfigs(): Map<string, SwitchportConfig> { return this.switchportConfigs; }
  _getSTPStates(): Map<string, STPPortState> { return this.stpStates; }
  _getDHCPSnoopingConfig(): DHCPSnoopingConfig { return this.dhcpSnooping; }
  _getDHCPSnoopingViolations(): number { return this.dhcpSnoopingViolations; }

  getDhcpSnoopingStats(): {
    forwarded: number;
    dropped: number;
    droppedUntrusted: number;
    droppedRateLimit: number;
    droppedVerifyMac: number;
  } {
    return {
      forwarded: this.dhcpSnoopingForwarded,
      dropped: this.dhcpSnoopingDroppedUntrusted
        + this.dhcpSnoopingDroppedRateLimit
        + this.dhcpSnoopingDroppedVerifyMac,
      droppedUntrusted: this.dhcpSnoopingDroppedUntrusted,
      droppedRateLimit: this.dhcpSnoopingDroppedRateLimit,
      droppedVerifyMac: this.dhcpSnoopingDroppedVerifyMac,
    };
  }
  _getDHCPSnoopingLog(): readonly string[] { return this.snoopingLog; }
  _getSnoopingBindings(): DHCPSnoopingBinding[] { return this.snoopingBindings; }
  _getSnoopingLog(): string[] { return this.snoopingLog; }
  _addSnoopingLog(msg: string): void { this.snoopingLog.push(msg); }
  _getInterfaceDescriptions(): Map<string, string> { return this.interfaceDescriptions; }

  // ─── Management plane: domain / SSH host keys / default-gateway ────
  private _domainName = '';

  private _ipDefaultGateway = '';
  /** @internal `ip domain-name` (device fallback for the shared handler). */
  _setDomainName(name: string): void { this._domainName = name; }
  getDomainName(): string { return this._domainName; }
  /** @internal `crypto key generate rsa`. */
  /**
   * Les cles RSA vivent dans `CiscoSecurityConfig`, attache a la machine
   * par un symbole — le MEME magasin que le routeur. Un booleen a part
   * donnait deux reponses a « cette machine a-t-elle une paire ? », et
   * c'est ce qui laissait `crypto key zeroize rsa` du commutateur
   * annoncer une suppression qui n'ecrivait dans aucun des deux.
   */
  _generateRsaKeys(): void {
    const sec = getSecurityConfig(this);
    if (sec.cryptoKeys.length === 0) {
      sec.cryptoKeys.push({
        label: `${this.getHostname()}.${this.getDomainName() ?? ''}`,
        modulus: 512, general: true, generatedAtMs: Date.now(),
      });
    }
  }
  hasRsaKeys(): boolean { return getSecurityConfig(this).cryptoKeys.length > 0; }
  /** @internal `ip default-gateway` (L2 switch management route). */
  _setDefaultGateway(ip: string): void { this._ipDefaultGateway = ip; }
  getDefaultGateway(): string { return this._ipDefaultGateway; }

  // ─── Local user database (`username …`) ───────────────────────────
  private _credentialStore: NetworkOsCredentialStore | null = null;
  /**
   * `transport input` sur les vty. Le magasin manquait au commutateur,
   * donc `transport input ssh` etait accepte et rendu nulle part —
   * perdu au rechargement d'une topologie. Il n'ouvre aucune ecoute
   * ici, ce commutateur n'ayant pas de pile TCP ; c'est la
   * configuration qui est conservee, pas un serveur qui demarre.
   */
  private vtyTransportInput: 'ssh' | 'telnet' | 'all' | 'none' = 'all';
  _setVtyTransportInput(t: 'ssh' | 'telnet' | 'all' | 'none', range?: { first: number; last: number }): void {
    if (range) {
      this._vtyLineConfig.upsert({ first: range.first, last: range.last, transportInput: t });
      return;
    }
    this.vtyTransportInput = t;
  }
  transportAdmisSurUneVty(kind: 'ssh' | 'telnet'): boolean {
    return this._vtyLineConfig.admetQuelquePart(kind, this.vtyTransportInput);
  }
  _getVtyTransportInput(): 'ssh' | 'telnet' | 'all' | 'none' {
    const ssh = this.transportAdmisSurUneVty('ssh');
    const telnet = this.transportAdmisSurUneVty('telnet');
    if (ssh && telnet) return 'all';
    if (ssh) return 'ssh';
    if (telnet) return 'telnet';
    return 'none';
  }

  private _aaaAuthenticator: AaaAuthenticator | null = null;

  /**
   * Un Catalyst authentifie par AAA comme un routeur : meme magasin
   * (attache par symbole), meme moteur. Il etait type contre `Router`,
   * donc `test aaa group` et toute la chaine AAA restaient hors de
   * portee du commutateur.
   */
  getAaaAuthenticator(): AaaAuthenticator {
    if (!this._aaaAuthenticator) this._aaaAuthenticator = new AaaAuthenticator(this as never);
    return this._aaaAuthenticator;
  }

  /**
   * Le registre de sessions nait AVEC le magasin d'identifiants, comme
   * cote routeur : il s'abonne aux authentifications reussies, donc le
   * construire paresseusement a la premiere lecture de `display users`
   * lui ferait manquer toutes celles d'avant — la vue serait vide sur
   * une machine ou quelqu'un est connecte.
   */
  getCredentialStore(): NetworkOsCredentialStore {
    if (!this._credentialStore) {
      this._sshSessionRegistry = new SshSessionRegistry({
        deviceId: this.id, bus: this.getBus(),
      });
      this._credentialStore = new NetworkOsCredentialStore({ deviceId: this.id, bus: this.getBus() });
    }
    return this._credentialStore;
  }

  /**
   * Un commutateur tient ses sessions comme un routeur.
   *
   * Il n'en avait aucun registre, donc `show users` et `display users`
   * ne pouvaient decrire personne : le premier retombait sur son texte
   * de repli et le second etait une constante. Le magasin
   * d'identifiants, lui, publiait deja ses authentifications sur le bus
   * — le registre s'y abonne, comme cote routeur.
   *
   * Ce qui reste vrai et n'est pas contourne : `Switch` n'a pas de pile
   * TCP, donc aucun serveur SSH ni telnet n'y ecoute. La seule session
   * qu'un commutateur puisse ouvrir est donc celle de sa console, et
   * c'est ce que la vue montrera.
   */
  getSshSessionRegistry(): SshSessionRegistry {
    if (!this._sshSessionRegistry) this.getCredentialStore();
    return this._sshSessionRegistry!;
  }
  private _sshSessionRegistry: SshSessionRegistry | null = null;

  readonly sshKnownHosts = new RouterSshKnownHosts();
  _getSshKnownHosts(): RouterSshKnownHosts { return this.sshKnownHosts; }

  consoleLineCount(): number { return 1; }

  private readonly dnsConfig = new CiscoDnsConfig();
  _getDnsConfig(): CiscoDnsConfig { return this.dnsConfig; }
  _syncDnsService(): void { /* un commutateur n'a pas de pile UDP a lier */ }

  private readonly dnsHostsTable = new RouterHostsTable();
  _getHostsTable(): RouterHostsTable { return this.dnsHostsTable; }
  /** @internal `username NAME [privilege N] [secret|password …]`. */
  _upsertCiscoUsername(name: string, kv: CiscoUsernamePatch): void {
    const store = this.getCredentialStore();
    store.upsert(applyCiscoUsernamePatch(
      store.get(name) ?? NetworkOsAccount.create({ name }), kv));
  }
  _removeLocalUser(name: string): void { this.getCredentialStore().remove(name); }

  // ─── VTY line configuration (`line vty …`) ────────────────────────
  private readonly _vtyLineConfig = new VtyLineConfigStore();
  /** @internal Used by the shared config-line handlers. */
  /**
   * Put the logging buffer on this device's bus, and gate its severity-7
   * lines behind this device's debug registry: those lines ARE `debug`
   * output, so they may only appear while the matching `debug` is on and
   * must stop on `undebug all`. A switch model with no debug service
   * keeps the ungated behaviour.
   */
  private attachLoggingBus(bus: import('@/events/EventBus').IEventBus): void {
    const shell = this.shell as unknown as {
      attachLoggingToBus?: (b: import('@/events/EventBus').IEventBus, id: string, d?: unknown) => void;
      getLoggingConfig?: () => {
        setDebugGate: (g: (tag: string) => boolean) => void;
        recordDebugLine: (text: string) => string;
      } | undefined;
    };
    shell.attachLoggingToBus?.(bus, this.id, this);
    const dev = this as unknown as {
      getDebugService?: () => {
        isEnabledForSyslogTag: (t: string) => boolean;
        setJournal?: (j: { record: (text: string) => string } | null) => void;
      };
    };
    if (!dev.getDebugService) return;
    const journal = shell.getLoggingConfig?.();
    if (!journal) return;
    journal.setDebugGate((tag) => dev.getDebugService!().isEnabledForSyslogTag(tag));
    dev.getDebugService().setJournal?.({ record: (text) => journal.recordDebugLine(text) });
  }

  /**
   * The syslog buffer behind `show logging`, and the console stream a
   * terminal subscribes to. The router has always exposed this; without
   * it on the switch a switch console showed neither %LINK/%LINEPROTO nor
   * any `debug` output — the buffer filled up and nothing ever read it.
   */
  getLoggingConfig(): import('./inspection/config/LoggingConfig').LoggingConfig | null {
    const shell = this.shell as unknown as {
      getLoggingConfig?: () => import('./inspection/config/LoggingConfig').LoggingConfig;
    };
    const cfg = shell.getLoggingConfig?.();
    if (!cfg) return null;
    this.attachLoggingBus(this.getBus());
    return cfg;
  }

  _getVtyLineConfig(): VtyLineConfigStore { return this._vtyLineConfig; }
  _listLocalUsers(): ReadonlyArray<{ name: string; privilege: number; secret: string; secretAlgo: PasswordHashAlgorithm; factoryDefault: boolean; noPassword: boolean; oneTime: boolean; noHangup: boolean; autocommand: string | null; description: string | null; view?: string; accessClassIn: number | null; maxConcurrentSessions: number }> {
    return this.getCredentialStore().list().map(a => ({
      name: a.name, privilege: a.privilege, secret: a.secret,
      secretAlgo: a.passwordHashAlgorithm, factoryDefault: a.factoryDefault,
      noPassword: a.noPassword, oneTime: a.oneTime, noHangup: a.noHangup,
      autocommand: a.autocommand, description: a.description,
      view: a.view ?? undefined,
      accessClassIn: a.accessClassIn, maxConcurrentSessions: a.maxConcurrentSessions,
    }));
  }

  // ─── ARP Snoop-learn into management table ──────────────────────

  /**
   * Real switches with an SVI populate their management ARP cache from
   * every broadcast/unicast ARP they observe — that's how `show ip arp`
   * lists hosts on the local segment without the switch ever sending an
   * ARP request itself. We replicate the same behaviour: any ARP frame
   * accepted by inspection is mirrored into the local `arpTable` (as
   * `dynamic`, never overwriting a `static` entry) and announced on the
   * bus so observers can react.
   */
  private snoopLearnArp(arp: ARPPacket, ingressPort: string, vlan: number): void {
    const ip = arp.senderIP.toString();
    if (ip === '0.0.0.0') return;
    const existing = this.arpTable.get(ip);
    if (existing && existing.type === 'static') return;
    const senderMacStr = arp.senderMAC.toString().toLowerCase();
    if (existing &&
        existing.mac.toString().toLowerCase() === senderMacStr &&
        existing.iface === ingressPort) {
      existing.timestamp = Date.now();
      return;
    }
    this.arpTable.set(ip, {
      mac: arp.senderMAC,
      iface: ingressPort,
      timestamp: Date.now(),
      type: 'dynamic',
    });
    this.getBus().publish({
      topic: 'arp.snoop.learned',
      payload: {
        switchId: this.id, switchName: this.name,
        ip, mac: senderMacStr, ingressPort, vlan,
      },
    });
  }

  // ─── DHCP server on an L3 switch ────────────────────────────────
  //
  // A Layer-3 switch can serve DHCP to its directly attached VLANs the
  // same way a router does. The server is created lazily, kept disabled
  // until `dhcp enable`, and is what EndHost.autoDiscoverDHCPServers
  // finds when it duck-types `getDHCPServer` on any reachable Equipment.
  private readonly dhcpServer: DHCPServer = new DHCPServer();
  _getDHCPServerInternal(): DHCPServer { return this.dhcpServer; }
  getDHCPServer(): DHCPServer { return this.dhcpServer; }

  // ─── VRRP on SVI (first-hop redundancy for L3 switches) ─────────
  // The FHRP agent runs against the SVI plane through a per-switch
  // adapter that presents each Vlanif as a synthetic "port". Elections
  // still use the same VRRP state machine as on routers — the only
  // change is where the interface lives (Vlanif vs GigabitEthernet0/0).
  private _vrrpAgent: VrrpAgent | null = null;
  private _hsrpAgent: HsrpAgent | null = null;
  private fhrpHost() {
    return makeSwitchVrrpHost(this, {
      egressOnVlan: (vlan, frame) => this.egressOnVlan(vlan, frame),
      vlanHasActivePort: (vlan) => this.vlanHasActivePort(vlan),
      getBridgeMac: () => this.getBridgeMac(),
    });
  }
  private ensureVrrpAgent(): VrrpAgent {
    if (this._vrrpAgent) return this._vrrpAgent;
    this._vrrpAgent = new VrrpAgent(this.fhrpHost(), () => this.getBus());
    this._vrrpAgent.start();
    return this._vrrpAgent;
  }
  private ensureHsrpAgent(): HsrpAgent {
    if (this._hsrpAgent) return this._hsrpAgent;
    this._hsrpAgent = new HsrpAgent(this.fhrpHost(), () => this.getBus());
    this._hsrpAgent.start();
    return this._hsrpAgent;
  }
  private _glbpAgent: GlbpAgent | null = null;
  private ensureGlbpAgent(): GlbpAgent {
    if (this._glbpAgent) return this._glbpAgent;
    this._glbpAgent = new GlbpAgent(this.fhrpHost(), () => this.getBus());
    this._glbpAgent.start();
    return this._glbpAgent;
  }
  /**
   * L'agent NTP du commutateur.
   *
   * Il n'existait pas : `Switch` n'instanciait aucun `NtpAgent`, donc
   * tout le chantier NTP ne concernait que les routeurs et les machines,
   * alors qu'un commutateur de niveau 3 sait parfaitement se
   * synchroniser et servir l'heure. C'est le MEME moteur que partout
   * ailleurs — un second moteur finirait par donner deux reponses a la
   * meme question — avec un hote qui expose les SVI comme des ports,
   * puisque c'est le Vlanif qui porte l'adresse.
   */
  private _ntpAgent: NtpAgent | null = null;
  getNtpAgent(): NtpAgent {
    if (this._ntpAgent) return this._ntpAgent;
    this._ntpAgent = new NtpAgent(
      makeSwitchNtpHost(this, {
        egressOnVlan: (vlan, frame) => this.egressOnVlan(vlan, frame),
        vlanHasActivePort: (vlan) => this.vlanHasActivePort(vlan),
        getBridgeMac: () => this.getBridgeMac(),
      }) as unknown as ConstructorParameters<typeof NtpAgent>[0],
      () => this.getBus());
    this._ntpAgent.start();
    return this._ntpAgent;
  }

  getVrrpAgent(): VrrpAgent { return this.ensureVrrpAgent(); }
  getHsrpAgent(): HsrpAgent { return this.ensureHsrpAgent(); }
  getGlbpAgent(): GlbpAgent { return this.ensureGlbpAgent(); }

  // ─── ARP Accessors (ARPProvider interface) ──────────────────────

  _getArpTableInternal() { return this.arpTable; }

  _getArpStats(): ArpStats { return this.arpStats; }

  _getSviVlanIds(): number[] { return this.getSvis().map((s) => s.vlan); }

  _addStaticARP(ip: IPAddress, mac: MACAddress, iface: string): void {
    this.arpTable.set(ip.toString(), { mac, iface, timestamp: Date.now(), type: 'static' });
  }

  _deleteARP(ip: IPAddress): boolean {
    return this.arpTable.delete(ip.toString());
  }

  _clearARPCache(): void {
    for (const [ip, entry] of this.arpTable) {
      if (entry.type !== 'static') {
        this.arpTable.delete(ip);
      }
    }
  }

  _vtpUpdaterIdentity(): string {
    const svis = this.getSvis().filter(s => s.ip).sort((a, b) => a.vlan - b.vlan);
    const first = svis[0];
    return first && first.ip ? first.ip.toString() : '0.0.0.0';
  }

  _vtpListVlans(): Array<{ id: number; name: string; mtu: number; type: 'ethernet' }> {
    const out: Array<{ id: number; name: string; mtu: number; type: 'ethernet' }> = [];
    for (const [, v] of this.vlans) {
      out.push({ id: v.id, name: v.name, mtu: 1500, type: 'ethernet' });
    }
    return out;
  }

  _vtpApplyVlans(incoming: ReadonlyArray<{ id: number; name: string }>): { added: number[]; removed: number[] } {
    const incomingIds = new Set(incoming.map(v => v.id));
    const added: number[] = [];
    const removed: number[] = [];
    for (const [id] of this.vlans) {
      if (id === 1) continue;
      if (!incomingIds.has(id)) {
        if (this.deleteVLAN(id)) removed.push(id);
      }
    }
    for (const v of incoming) {
      if (v.id === 1) continue;
      const existing = this.vlans.get(v.id);
      if (!existing) {
        if (this.createVLAN(v.id, v.name)) added.push(v.id);
      } else if (existing.name !== v.name) {
        this.renameVLAN(v.id, v.name);
      }
    }
    return { added, removed };
  }

  _vtpIsTrunkPort(portName: string): boolean {
    const cfg = this.switchportConfigs.get(portName);
    return !!cfg && cfg.mode === 'trunk';
  }

  _vtpLocalInterest(): number[] {
    const out = new Set<number>();
    for (const [portName, cfg] of this.switchportConfigs) {
      if (cfg.mode !== 'access') continue;
      const port = this.getPort(portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;
      out.add(cfg.accessVlan);
    }
    return [...out];
  }

  // ─── DAI Accessors ────────────────────────────────────────────────

  _getArpInspectionConfig(): ArpInspectionConfig { return this.arpInspection; }
  _getArpAccessLists(): Map<string, ArpAccessList> { return this.arpAccessLists; }
  _getArpErrDisabledPorts(): Set<string> { return this.arpErrDisabledPorts; }
  _getArpInspectionStats() {
    return this.arpInspectionPipeline?.getStats() ?? new Map();
  }
  _getArpInspectionPortStats(port: string) {
    return this.arpInspectionPipeline?.getPortStats(port);
  }
  _getArpInspectionLog() {
    return this.arpInspectionPipeline?.getLog() ?? [];
  }
  _clearArpInspectionErrDisable(port: string): boolean {
    if (!this.arpErrDisabledPorts.delete(port)) return false;
    this.arpErrDisableTimestamps.delete(port);
    const p = this.getPort(port);
    if (p) p.setUp(true);
    this.getBus().publish({
      topic: 'arp.errdisable.cleared',
      payload: { switchId: this.id, switchName: this.name, port },
    });
    if (this.arpErrDisabledPorts.size === 0) this.stopRecoveryTimer();
    return true;
  }
  _setArpRecoverySec(sec: number): void {
    this.arpInspection.errDisableRecoverySec = Math.max(0, sec);
    if (this.arpInspection.errDisableRecoverySec > 0 && this.arpErrDisabledPorts.size > 0) {
      this.ensureRecoveryTimer();
    } else if (this.arpInspection.errDisableRecoverySec === 0) {
      this.stopRecoveryTimer();
    }
  }
  _resetArpInspectionStats(): void {
    this.arpInspectionPipeline?.resetStats();
  }

  // ─── Port-Security accessors ─────────────────────────────────────

  _getPsecRecoverySec(): number { return this.psecRecoverySec; }
  _setPsecRecoverySec(sec: number): void {
    this.psecRecoverySec = Math.max(0, sec);
    if (this.psecRecoverySec > 0 && this.psecErrDisabledPorts.size > 0) {
      this.ensurePsecRecoveryTimer();
    } else if (this.psecRecoverySec === 0) {
      this.stopPsecRecoveryTimer();
    }
  }
  _getPsecErrDisabledPorts(): Set<string> { return this.psecErrDisabledPorts; }
  _clearPsecErrDisable(port: string): boolean {
    if (!this.psecErrDisabledPorts.delete(port)) return false;
    this.psecErrDisableTimestamps.delete(port);
    const p = this.getPort(port);
    if (p) {
      p.getPortSecurity().resetViolationCount();
      p.setUp(true);
    }
    this.getBus().publish({
      topic: 'port.security.errdisable.cleared',
      payload: { deviceId: this.id, portName: port },
    });
    if (this.psecErrDisabledPorts.size === 0) this.stopPsecRecoveryTimer();
    return true;
  }

  // ─── CLI ──────────────────────────────────────────────────────────

  getPrompt(): string { return this.shell.getPrompt(this); }

  resetCliMode(): void { this.shell.resetCliMode?.(); }

  /** Get CLI help for the given input (used by terminal UI for inline ? behavior) */
  cliExecutablePaths(): string[] {
    return (this.shell as unknown as { executablePathsInCurrentMode?: () => string[] })
      .executablePathsInCurrentMode?.() ?? [];
  }

  cliCommandPaths(): string[] {
    return (this.shell as unknown as { commandPathsInCurrentMode?: () => string[] })
      .commandPathsInCurrentMode?.() ?? [];
  }

  cliDerivedContinuations(): string[] {
    return (this.shell as unknown as { derivedContinuationsInCurrentMode?: () => string[] })
      .derivedContinuationsInCurrentMode?.() ?? [];
  }

  cliUndescribedContinuations(): string[] {
    return (this.shell as unknown as { undescribedContinuationsInCurrentMode?: () => string[] })
      .undescribedContinuationsInCurrentMode?.() ?? [];
  }

  cliHelp(inputBeforeQuestion: string): string {
    return this.shell.getHelp(inputBeforeQuestion, this);
  }

  /** Get CLI tab completion for the given input (used by terminal UI) */
  cliTabComplete(input: string): string | null {
    return this.shell.tabComplete(input, this);
  }

  /** All full-line Tab candidates (static keywords + live device values). */
  cliTabCandidates(input: string): string[] {
    return this.shell.tabCandidates(input, this);
  }

  /** Learned/static MAC addresses, for dynamic MAC_ADDR completion. */
  getKnownMacAddresses(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of this.macTable.values()) {
      if (seen.has(entry.mac)) continue;
      seen.add(entry.mac);
      out.push(entry.mac);
    }
    return out;
  }

  // getBootSequence() and getOSType() are abstract — implemented by CiscoSwitch / HuaweiSwitch

  getBanner(type: string = 'motd'): string {
    if (type === 'motd') return this.motdBannerText;
    if (type === 'login') return this.loginBannerText;
    if (type === 'exec') return this.execBannerText;
    if (type === 'incoming') return this.incomingBannerText;
    return '';
  }

  protected motdBannerText: string = '';
  protected loginBannerText: string = '';
  protected execBannerText: string = '';
  protected incomingBannerText: string = '';

  _setMotdBanner(text: string): void { this.motdBannerText = text; }
  _setLoginBanner(text: string): void { this.loginBannerText = text; }
  _setExecBanner(text: string): void { this.execBannerText = text; }
  _setIncomingBanner(text: string): void { this.incomingBannerText = text; }

  async executeCommand(command: string, answers?: HeadlessAnswers): Promise<string> {
    if (!this.isPoweredOn) return '% Device is powered off';
    if (hasHeadlessAnswers(answers)) {
      const dialogue = await this.jouerDialogueSansTerminal(command, answers as HeadlessAnswers);
      if (dialogue !== null) return dialogue;
    }
    const porteAaa = this.refusAutorisationAaa(command);
    if (porteAaa !== null) {
      const refus = await porteAaa;
      if (refus !== null) return refus;
    }
    return this.shell.execute(this, command);
  }

  /**
   * Le pendant exact de `Router.refusAutorisationAaa` : un Catalyst
   * porte le meme sous-systeme AAA, et laisser la porte ouverte ici
   * ferait d'une plateforme la faille de l'autre.
   */
  protected refusAutorisationAaa(command: string): Promise<string | null> | null {
    const ligne = command.trim();
    if (ligne === '') return null;
    const shell = this.shell as unknown as {
      niveauEffectifDe?: (c: string, d?: unknown) => number | null;
      utilisateurDeSession?: () => string | null;
    };
    const utilisateur = shell.utilisateurDeSession?.() ?? null;
    if (!utilisateur) return null;
    const niveau = shell.niveauEffectifDe?.(ligne, this) ?? null;
    if (niveau === null) return null;
    const aaa = this.getAaaAuthenticator();
    if (!aaa.hasCommandAuthorization(niveau)) return null;
    return aaa.authorizeCommand(utilisateur, ligne, niveau)
      .then((v) => (v === 'denied' ? 'Command authorization failed.' : null));
  }

  /**
   * Le pendant exact de `Router.jouerDialogueSansTerminal` : un
   * commutateur porte le meme `enable secret` et le meme plan
   * d'interaction, donc laisser la porte ouverte ici et fermee la-bas
   * ferait de la plateforme le facteur de securite.
   */
  private async jouerDialogueSansTerminal(
    command: string, answers: HeadlessAnswers,
  ): Promise<string | null> {
    const shell = this.shell as unknown as { getMode?: () => string };
    if (!isInteractionPlanner(this.shell)) return null;
    const plan = this.shell.interactionPlanFor(command, {
      mode: shell.getMode?.() ?? 'privileged',
      device: this,
      onVtyLine: false,
    });
    if (!plan) return null;
    return runInteractionPlanHeadless(
      plan, answers, (c) => Promise.resolve(this.shell.execute(this, c)));
  }

  async loginAs(username: string, password: string): Promise<boolean> {
    if (!this.isPoweredOn) return false;
    if (!this.getCredentialStore().authenticate(username, password)) {
      this.getCredentialStore().recordLoginFailure(username, '', 'bad password', Date.now());
      return false;
    }
    const compte = this.getCredentialStore().lookup(username);
    const niveau = compte?.privilege ?? 1;
    const shell = this.shell as unknown as {
      beginExecSession?: (lvl: number, u?: string, vue?: string | null) => void;
    };
    shell.beginExecSession?.(niveau, username, compte?.view ?? null);
    return true;
  }

  // ─── vty sessions (per-terminal CLI isolation) ────────────────────
  // Cisco/Huawei switch shells are a single instance shared by every
  // open terminal (no per-vty allocation like Router). Mirrors
  // Router.ts's swap-and-restore pattern so two concurrently open
  // terminals on the same switch don't observe each other's mode /
  // sub-mode pointers.

  private readonly vtySessions = new Map<string, CliShellSession>();
  private vtyExecQueue: Promise<unknown> = Promise.resolve();

  openVtySession(): CliShellSession {
    const s = new CliShellSession({ initialMode: 'user' });
    this.vtySessions.set(s.id, s);
    return s;
  }

  closeVtySession(sessionOrId: CliShellSession | string): void {
    const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id;
    const s = this.vtySessions.get(id);
    if (!s) return;
    s.dispose();
    this.vtySessions.delete(id);
  }

  getVtySession(id: string): CliShellSession | undefined {
    return this.vtySessions.get(id);
  }

  private vtyShellHooks(): {
    snapshotVtyState?: () => import('./shells/vty/CliShellSession').VtySnapshot;
    applyVtyState?: (s: import('./shells/vty/CliShellSession').VtySnapshot) => void;
  } {
    return this.shell as unknown as {
      snapshotVtyState?: () => import('./shells/vty/CliShellSession').VtySnapshot;
      applyVtyState?: (s: import('./shells/vty/CliShellSession').VtySnapshot) => void;
    };
  }

  async executeCommandInVty(
    command: string, session: CliShellSession, answers?: HeadlessAnswers,
  ): Promise<string> {
    const shell = this.vtyShellHooks();
    if (!shell.snapshotVtyState || !shell.applyVtyState) {
      return this.executeCommand(command, answers);
    }
    const run = async (): Promise<string> => {
      if (!this.isPoweredOn) return '% Device is powered off';
      if (session.disposed) return '';
      const baseline = shell.snapshotVtyState!();
      shell.applyVtyState!(session.state);
      if (session.lineRecordId !== null) {
        getSessionRegistry(this)?.setCurrentSession(session.lineRecordId);
      }
      try {
        const out = await this.executeCommand(command, answers);
        session.state = shell.snapshotVtyState!();
        return out;
      } finally {
        shell.applyVtyState!(baseline);
      }
    };
    const promise = this.vtyExecQueue.then(run, run) as Promise<string>;
    this.vtyExecQueue = promise.catch(() => undefined);
    return promise;
  }

  private withSwappedVtyState<T>(session: CliShellSession, fn: () => T): T | null {
    const shell = this.vtyShellHooks();
    if (!shell.snapshotVtyState || !shell.applyVtyState) return null;
    const baseline = shell.snapshotVtyState();
    shell.applyVtyState(session.state);
    try {
      return fn();
    } finally {
      shell.applyVtyState(baseline);
    }
  }

  cliHelpForVty(input: string, session: CliShellSession): string {
    return this.withSwappedVtyState(session, () => this.cliHelp(input)) ?? this.cliHelp(input);
  }

  cliTabCompleteForVty(input: string, session: CliShellSession): string | null {
    return this.withSwappedVtyState(session, () => this.cliTabComplete(input));
  }

  cliTabCandidatesForVty(input: string, session: CliShellSession): string[] {
    return this.withSwappedVtyState(session, () => this.cliTabCandidates(input)) ?? [];
  }

  getPromptForVty(session: CliShellSession): string {
    const shell = this.vtyShellHooks();
    if (!shell.snapshotVtyState || !shell.applyVtyState) return this.getPrompt();
    const baseline = shell.snapshotVtyState();
    shell.applyVtyState(session.state);
    try {
      return this.getPrompt();
    } finally {
      shell.applyVtyState(baseline);
    }
  }
}
