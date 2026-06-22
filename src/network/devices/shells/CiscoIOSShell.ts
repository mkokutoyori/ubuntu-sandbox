/**
 * CiscoIOSShell - Cisco IOS CLI emulation for Router Management Plane
 *
 * Extends CiscoShellBase<Router> to inherit shared execute loop, FSM,
 * help/tab-complete, and common commands (enable, configure, ARP, hostname).
 *
 * Router-specific additions:
 *   - ping (async ICMP echo)
 *   - traceroute (ICMP-based path trace)
 *   - show ip route, show running-config, show version, etc.
 *   - DHCP, RIP, OSPF, ACL, IPSec sub-modes and commands
 *
 * Modes (FSM States):
 *   user, privileged, config, config-if, config-dhcp, config-router,
 *   config-router-ospf, config-router-ospfv3, config-std-nacl,
 *   config-ext-nacl, config-ipv6-nacl, config-isakmp, config-tfset,
 *   config-crypto-map, config-ipsec-profile, config-ikev2-*
 */

import type { Router } from '../Router';
import type { IRouterShell } from './IRouterShell';
import { CiscoShellBase } from './CiscoShellBase';
import { CommandTrie } from './CommandTrie';
import { IPAddress } from '../../core/types';
import { parsePingArgs, formatCiscoPing } from './cisco/ciscoPing';
import type { PromptMap } from './PromptBuilder';
import { CISCO_IOS_PROMPTS } from './PromptBuilder';
import { CLIStateMachine, CISCO_IOS_MODES } from './CLIStateMachine';
import { resolveInterfaceName } from './cisco/CiscoConfigCommands';
import {
  buildHsrpInterfaceCommands, registerHsrpShowCommands,
} from './cisco/CiscoHsrpCommands';
import {
  buildVrrpGlbpInterfaceCommands, registerVrrpGlbpShowCommands,
} from './cisco/CiscoVrrpGlbpCommands';
import {
  buildBfdInterfaceCommands, registerBfdShowCommands,
} from './cisco/CiscoBfdCommands';
import {
  buildIgmpInterfaceCommands, registerIgmpShowCommands,
} from './cisco/CiscoIgmpCommands';
import {
  buildPimInterfaceCommands, buildPimGlobalConfigCommands, registerPimShowCommands,
} from './cisco/CiscoPimCommands';
import {
  buildVxlanInterfaceCommands, registerVxlanShowCommands,
} from './cisco/CiscoVxlanCommands';
import {
  buildTrackSlaConfig, registerTrackSlaShow,
} from './cisco/CiscoTrackSlaCommands';
import { FhrpRepository } from '../inspection/config/FhrpRepository';
import { TrackRepository } from '../inspection/config/TrackRepository';
import { KeyChainRepository } from '../inspection/config/KeyChainRepository';
import { IpSlaRepository } from '../inspection/config/IpSlaRepository';
import { PolicyRepository } from '../inspection/config/PolicyRepository';
import {
  buildPolicyConfig, registerPolicyShow,
} from './cisco/CiscoPolicyCommands';

// Extracted command modules
import * as Show from './cisco/CiscoShowCommands';
import {
  type CiscoShellMode, type CiscoShellContext,
  buildConfigCommands, buildConfigIfCommands,
} from './cisco/CiscoConfigCommands';
import {
  buildConfigDhcpCommands, buildConfigDhcpPoolClassCommands,
  buildConfigDhcpClassCommands,
  buildConfigIpv6DhcpCommands,
  registerDhcpShowCommands,
  registerDhcpPrivilegedCommands,
} from './cisco/CiscoDhcpCommands';
import {
  registerKeyChainGlobalCommands,
  buildKeyChainSubmode,
  buildKeyChainKeySubmode,
  registerKeyChainShowCommands,
} from './cisco/CiscoKeyChainCommands';
import {
  buildRoutingProtoConfig, registerRoutingProtoShow,
} from './cisco/CiscoRoutingProtoCommands';
import { RoutingConfigRepository } from '../inspection/config/RoutingConfigRepository';
import {
  type CiscoACLShellContext,
  buildACLConfigCommands, buildACLInterfaceCommands,
  buildNamedStdACLCommands, buildNamedExtACLCommands,
  buildIPv6ACLGlobalCommands, buildIPv6ACLModeCommands,
  registerACLShowCommands,
} from './cisco/CiscoAclCommands';
import {
  registerOSPFConfigCommands, buildConfigRouterOSPFCommands,
  buildConfigRouterOSPFv3Commands,
  registerOSPFInterfaceCommands, registerOSPFShowCommands,
} from './cisco/CiscoOspfCommands';
import {
  buildIPSecGlobalCommands, buildISAKMPPolicyCommands, buildISAKMPProfileCommands,
  buildTransformSetCommands, buildCryptoMapEntryCommands,
  buildIPSecProfileCommands, buildIPSecIfCommands,
  buildIPSecPrivilegedCommands,
} from './cisco/CiscoIPSecIKEv1Commands';
import {
  buildIKEv2GlobalCommands, buildIKEv2ProposalCommands,
  buildIKEv2PolicyCommands, buildIKEv2KeyringCommands,
  buildIKEv2KeyringPeerCommands, buildIKEv2ProfileCommands,
} from './cisco/CiscoIPSecIKEv2Commands';
import { registerIPSecShowCommands } from './cisco/CiscoIPSecShowCommands';
import {
  buildSecurityConfigCommands, buildSecurityInterfaceCommands,
  buildSecuritySubmodeCommands, buildSecurityShowCommands,
} from './cisco/CiscoSecurityCommands';
import {
  buildEemNetflowArchiveConfigCommands, buildEemAppletSubmode,
  buildFlowExporterSubmode, buildFlowRecordSubmode, buildFlowMonitorSubmode,
  buildArchiveSubmode, buildArchiveLogSubmode,
  buildEemNetflowArchiveInterfaceCommands, buildEemNetflowArchiveShowCommands,
} from './cisco/CiscoEemNetflowArchiveCommands';
import {
  buildNATConfigCommands, buildNATInterfaceCommands,
  registerNATPrivilegedCommands, registerNATShowCommands,
} from './cisco/CiscoNATCommands';

export class CiscoIOSShell extends CiscoShellBase<Router> implements IRouterShell, CiscoShellContext, CiscoACLShellContext {
  // ─── Router-specific state ───────────────────────────────────────
  private selectedInterface: string | null = null;
  /** Real config-driven HSRP/VRRP/GLBP state (router-only; L2 switches none). */
  private readonly fhrp = new FhrpRepository();
  private readonly keyChains = new KeyChainRepository();
  getKeyChains(): KeyChainRepository { return this.keyChains; }
  /** Real config-driven object-tracking & IP SLA state. */
  private readonly track = new TrackRepository();
  private readonly ipsla = new IpSlaRepository();
  private readonly policy = new PolicyRepository();
  private readonly routingCfg = new RoutingConfigRepository();
  private selectedRoutingProto: { proto: 'rip' | 'eigrp' | 'bgp'; asn?: number } | null = null;
  getSelectedRoutingProto(): { proto: 'rip' | 'eigrp' | 'bgp'; asn?: number } | null {
    return this.selectedRoutingProto;
  }
  setSelectedRoutingProto(v: { proto: 'rip' | 'eigrp' | 'bgp'; asn?: number } | null): void {
    this.selectedRoutingProto = v;
  }
  private selectedTrack: number | null = null;
  private selectedIpSla: number | null = null;
  private selectedRouteMap: { name: string; seq: number } | null = null;
  getSelectedRouteMap(): { name: string; seq: number } | null { return this.selectedRouteMap; }
  setSelectedRouteMap(v: { name: string; seq: number } | null): void { this.selectedRouteMap = v; }
  getSelectedTrack(): number | null { return this.selectedTrack; }
  setSelectedTrack(id: number | null): void { this.selectedTrack = id; }
  getSelectedIpSla(): number | null { return this.selectedIpSla; }
  setSelectedIpSla(id: number | null): void { this.selectedIpSla = id; }
  private selectedDHCPPool: string | null = null;
  private selectedACL: string | null = null;
  private selectedACLType: 'standard' | 'extended' | null = null;

  // IPSec selection state
  private selectedISAKMPPriority: number | null = null;
  private selectedISAKMPProfile: string | null = null;
  private selectedTransformSet: string | null = null;
  private selectedCryptoMap: string | null = null;
  private selectedCryptoMapSeq: number | null = null;
  private selectedCryptoMapIsDynamic: boolean = false;
  private selectedIPSecProfile: string | null = null;
  private selectedIKEv2Proposal: string | null = null;
  private selectedIKEv2Policy: string | null = null;
  private selectedIKEv2Keyring: string | null = null;
  private selectedIKEv2KeyringPeer: string | null = null;
  private selectedIKEv2Profile: string | null = null;

  // ─── FSM (router-specific mode hierarchy) ────────────────────────
  protected readonly fsm = new CLIStateMachine<CiscoShellMode>('user', CISCO_IOS_MODES, 'user', 'privileged');

  // ─── Additional tries (beyond base's user/privileged/config/configIf) ─
  private configDhcpTrie = new CommandTrie();
  private configDhcpPoolClassTrie = new CommandTrie();
  private configTrackTrie = new CommandTrie();
  private configIpSlaTrie = new CommandTrie();
  private configRouteMapTrie = new CommandTrie();
  private configRouterTrie = new CommandTrie();
  private configRouterOspfTrie = new CommandTrie();
  private configRouterOspfv3Trie = new CommandTrie();
  private configStdNaclTrie = new CommandTrie();
  private configExtNaclTrie = new CommandTrie();
  private configIpv6NaclTrie = new CommandTrie();
  // IPSec sub-mode tries
  private configIsakmpTrie = new CommandTrie();
  private configIsakmpProfileTrie = new CommandTrie();
  private configTfsetTrie = new CommandTrie();
  private configCryptoMapTrie = new CommandTrie();
  private configIpsecProfileTrie = new CommandTrie();
  private configIkev2ProposalTrie = new CommandTrie();
  private configIkev2PolicyTrie = new CommandTrie();
  private configIkev2KeyringTrie = new CommandTrie();
  private configIkev2KeyringPeerTrie = new CommandTrie();
  private configIkev2ProfileTrie = new CommandTrie();
  private configTimeRangeTrie = new CommandTrie();
  private configCmapTrie = new CommandTrie();
  private configPmapTrie = new CommandTrie();
  private configPmapClassTrie = new CommandTrie();
  private configCpTrie = new CommandTrie();
  private configZoneTrie = new CommandTrie();
  private configZonePairTrie = new CommandTrie();
  private configRadiusServerTrie = new CommandTrie();
  private configTacacsServerTrie = new CommandTrie();
  private configAaaGroupTrie = new CommandTrie();
  private configCaTrustpointTrie = new CommandTrie();
  private configAppletTrie = new CommandTrie();
  private configFlowExporterTrie = new CommandTrie();
  private configFlowRecordTrie = new CommandTrie();
  private configFlowMonitorTrie = new CommandTrie();
  private configArchiveTrie = new CommandTrie();
  private configArchiveLogTrie = new CommandTrie();
  private configDhcpClassTrie = new CommandTrie();
  private configIpv6DhcpTrie = new CommandTrie();
  private configKeychainTrie = new CommandTrie();
  private configKeychainKeyTrie = new CommandTrie();
  private selectedKeyChain: string | null = null;
  private selectedKeyChainKey: number | null = null;
  getSelectedKeyChain(): string | null { return this.selectedKeyChain; }
  setSelectedKeyChain(n: string | null): void { this.selectedKeyChain = n; }
  getSelectedKeyChainKey(): number | null { return this.selectedKeyChainKey; }
  setSelectedKeyChainKey(n: number | null): void { this.selectedKeyChainKey = n; }

  private selectedTimeRange: string | null = null;
  private selectedClassMap: string | null = null;
  private selectedPolicyMap: string | null = null;
  private selectedPolicyClass: string | null = null;
  private controlPlaneActive: boolean = false;
  private selectedZone: string | null = null;
  private selectedZonePair: string | null = null;
  private selectedRadiusServer: string | null = null;
  private selectedTacacsServer: string | null = null;
  private selectedAaaGroup: string | null = null;
  private selectedPkiTrustpoint: string | null = null;
  private selectedApplet: string | null = null;
  private selectedFlowExporter: string | null = null;
  private selectedFlowRecord: string | null = null;
  private selectedFlowMonitor: string | null = null;

  getTimeRange(): string | null { return this.selectedTimeRange; }
  setTimeRange(n: string | null): void { this.selectedTimeRange = n; }
  getClassMap(): string | null { return this.selectedClassMap; }
  setClassMap(n: string | null): void { this.selectedClassMap = n; }
  getPolicyMap(): string | null { return this.selectedPolicyMap; }
  setPolicyMap(n: string | null): void { this.selectedPolicyMap = n; }
  getPolicyClass(): string | null { return this.selectedPolicyClass; }
  setPolicyClass(n: string | null): void { this.selectedPolicyClass = n; }
  getControlPlane(): boolean { return this.controlPlaneActive; }
  setControlPlane(v: boolean): void { this.controlPlaneActive = v; }
  getZone(): string | null { return this.selectedZone; }
  setZone(n: string | null): void { this.selectedZone = n; }
  getZonePair(): string | null { return this.selectedZonePair; }
  setZonePair(n: string | null): void { this.selectedZonePair = n; }
  getRadiusServer(): string | null { return this.selectedRadiusServer; }
  setRadiusServer(n: string | null): void { this.selectedRadiusServer = n; }
  getTacacsServer(): string | null { return this.selectedTacacsServer; }
  setTacacsServer(n: string | null): void { this.selectedTacacsServer = n; }
  getAaaGroup(): string | null { return this.selectedAaaGroup; }
  setAaaGroup(n: string | null): void { this.selectedAaaGroup = n; }
  getPkiTrustpoint(): string | null { return this.selectedPkiTrustpoint; }
  setPkiTrustpoint(n: string | null): void { this.selectedPkiTrustpoint = n; }
  getApplet(): string | null { return this.selectedApplet; }
  setApplet(n: string | null): void { this.selectedApplet = n; }
  getFlowExporter(): string | null { return this.selectedFlowExporter; }
  setFlowExporter(n: string | null): void { this.selectedFlowExporter = n; }
  getFlowRecord(): string | null { return this.selectedFlowRecord; }
  setFlowRecord(n: string | null): void { this.selectedFlowRecord = n; }
  getFlowMonitor(): string | null { return this.selectedFlowMonitor; }
  setFlowMonitor(n: string | null): void { this.selectedFlowMonitor = n; }

  constructor() {
    super();
    this.initializeCommands();
  }

  // ─── IRouterShell ────────────────────────────────────────────────

  getOSType(): string { return 'cisco-ios'; }

  execute(router: Router, rawInput: string): string | Promise<string> {
    this.attachDebugSource((router as unknown as { getDebugService?: () => { subscribe(l: (line: string) => void): () => void } }).getDebugService?.());
    if (rawInput.trim() === '') return this.drainDebugConsole();
    return this.executeOnDevice(router, rawInput);
  }

  getPrompt(router: Router): string {
    return this.buildDevicePrompt(router);
  }

  // ─── CiscoShellContext Implementation ────────────────────────────

  r(): Router { return this.d(); }

  setMode(mode: CiscoShellMode): void { this.mode = mode; }

  override getMode(): CiscoShellMode { return this.mode as CiscoShellMode; }

  getSelectedInterface(): string | null { return this.selectedInterface; }
  setSelectedInterface(iface: string | null): void { this.selectedInterface = iface; }

  getSelectedDHCPPool(): string | null { return this.selectedDHCPPool; }
  setSelectedDHCPPool(pool: string | null): void { this.selectedDHCPPool = pool; }

  resolveInterfaceName(input: string): string | null {
    return resolveInterfaceName(this.r(), input);
  }

  getSelectedACL(): string | null { return this.selectedACL; }
  setSelectedACL(name: string | null): void { this.selectedACL = name; }
  getSelectedACLType(): 'standard' | 'extended' | null { return this.selectedACLType; }
  setSelectedACLType(type: 'standard' | 'extended' | null): void { this.selectedACLType = type; }

  // IPSec context getters/setters
  getSelectedISAKMPPriority(): number | null { return this.selectedISAKMPPriority; }
  setSelectedISAKMPPriority(p: number | null): void { this.selectedISAKMPPriority = p; }
  getSelectedISAKMPProfile(): string | null { return this.selectedISAKMPProfile; }
  setSelectedISAKMPProfile(p: string | null): void { this.selectedISAKMPProfile = p; }
  getSelectedTransformSet(): string | null { return this.selectedTransformSet; }
  setSelectedTransformSet(ts: string | null): void { this.selectedTransformSet = ts; }
  getSelectedCryptoMap(): string | null { return this.selectedCryptoMap; }
  setSelectedCryptoMap(m: string | null): void { this.selectedCryptoMap = m; }
  getSelectedCryptoMapSeq(): number | null { return this.selectedCryptoMapSeq; }
  setSelectedCryptoMapSeq(seq: number | null): void { this.selectedCryptoMapSeq = seq; }
  getSelectedCryptoMapIsDynamic(): boolean { return this.selectedCryptoMapIsDynamic; }
  setSelectedCryptoMapIsDynamic(d: boolean): void { this.selectedCryptoMapIsDynamic = d; }
  getSelectedIPSecProfile(): string | null { return this.selectedIPSecProfile; }
  setSelectedIPSecProfile(p: string | null): void { this.selectedIPSecProfile = p; }
  getSelectedIKEv2Proposal(): string | null { return this.selectedIKEv2Proposal; }
  setSelectedIKEv2Proposal(p: string | null): void { this.selectedIKEv2Proposal = p; }
  getSelectedIKEv2Policy(): string | null { return this.selectedIKEv2Policy; }
  setSelectedIKEv2Policy(n: string | null): void { this.selectedIKEv2Policy = n; }
  getSelectedIKEv2Keyring(): string | null { return this.selectedIKEv2Keyring; }
  setSelectedIKEv2Keyring(k: string | null): void { this.selectedIKEv2Keyring = k; }
  getSelectedIKEv2KeyringPeer(): string | null { return this.selectedIKEv2KeyringPeer; }
  setSelectedIKEv2KeyringPeer(p: string | null): void { this.selectedIKEv2KeyringPeer = p; }
  getSelectedIKEv2Profile(): string | null { return this.selectedIKEv2Profile; }
  setSelectedIKEv2Profile(p: string | null): void { this.selectedIKEv2Profile = p; }

  // ─── Per-vty state snapshot / swap (§5.1 of terminal_gap.md) ─────

  /**
   * Capture every mode-related field into a snapshot. The shell is
   * single-instance per device — to give each terminal its own vty we
   * snapshot, swap in the per-session state, run synchronously, then
   * restore. Concurrent calls are serialised at the device layer (cf.
   * Router.executeCommandInVty) so the swap window is never observed
   * across terminals.
   *
   * Async commands (ping, traceroute) capture the field values BEFORE
   * the await: by the time the Promise resolves the swap-out has
   * already happened, but the closures hold the right state via
   * `_pendingAsync`. The shell ensures it.
   */
  snapshotVtyState(): import('./vty/CliShellSession').VtySnapshot {
    return {
      mode: this.mode,
      selectedInterface: this.selectedInterface,
      selectedRoutingProto: this.selectedRoutingProto,
      selectedTrack: this.selectedTrack,
      selectedIpSla: this.selectedIpSla,
      selectedRouteMap: this.selectedRouteMap,
      selectedDHCPPool: this.selectedDHCPPool,
      selectedACL: this.selectedACL,
      selectedACLType: this.selectedACLType,
      selectedISAKMPPriority: this.selectedISAKMPPriority,
      selectedTransformSet: this.selectedTransformSet,
      selectedCryptoMap: this.selectedCryptoMap,
      selectedCryptoMapSeq: this.selectedCryptoMapSeq,
      selectedCryptoMapIsDynamic: this.selectedCryptoMapIsDynamic,
      selectedIPSecProfile: this.selectedIPSecProfile,
      selectedIKEv2Proposal: this.selectedIKEv2Proposal,
      selectedIKEv2Policy: this.selectedIKEv2Policy,
      selectedIKEv2Keyring: this.selectedIKEv2Keyring,
      selectedIKEv2KeyringPeer: this.selectedIKEv2KeyringPeer,
      selectedIKEv2Profile: this.selectedIKEv2Profile,
      terminalLength: this.terminalLength,
      terminalWidth: this.terminalWidth,
      terminalMonitor: this.terminalMonitor,
      privilegeLevel: this.mode === 'user' ? 1 : 15,
      historySize: 10,
      cmdHistory: this.cmdHistory,
    };
  }

  /** Apply a session's snapshot onto this shell instance. */
  applyVtyState(s: import('./vty/CliShellSession').VtySnapshot): void {
    this.mode = s.mode as CiscoShellMode;
    this.selectedInterface = s.selectedInterface;
    this.selectedRoutingProto = s.selectedRoutingProto as typeof this.selectedRoutingProto;
    this.selectedTrack = s.selectedTrack;
    this.selectedIpSla = s.selectedIpSla;
    this.selectedRouteMap = s.selectedRouteMap as typeof this.selectedRouteMap;
    this.selectedDHCPPool = s.selectedDHCPPool;
    this.selectedACL = s.selectedACL;
    this.selectedACLType = s.selectedACLType;
    this.selectedISAKMPPriority = s.selectedISAKMPPriority;
    this.selectedTransformSet = s.selectedTransformSet;
    this.selectedCryptoMap = s.selectedCryptoMap;
    this.selectedCryptoMapSeq = s.selectedCryptoMapSeq;
    this.selectedCryptoMapIsDynamic = s.selectedCryptoMapIsDynamic;
    this.selectedIPSecProfile = s.selectedIPSecProfile;
    this.selectedIKEv2Proposal = s.selectedIKEv2Proposal;
    this.selectedIKEv2Policy = s.selectedIKEv2Policy;
    this.selectedIKEv2Keyring = s.selectedIKEv2Keyring;
    this.selectedIKEv2KeyringPeer = s.selectedIKEv2KeyringPeer;
    this.selectedIKEv2Profile = s.selectedIKEv2Profile;
    this.terminalLength = s.terminalLength;
    this.terminalWidth = s.terminalWidth;
    this.terminalMonitor = s.terminalMonitor;
    this.cmdHistory = s.cmdHistory;
  }

  // ─── Abstract Method Implementations ─────────────────────────────

  protected getPromptMap(): PromptMap { return CISCO_IOS_PROMPTS; }

  protected override getChassisProfile(): import('./cisco/CiscoCommonShow').CiscoChassisProfile {
    return 'router-isr2911';
  }

  /** Real saved configuration (null until first `write memory`). */
  private startupConfig: string | null = null;

  protected onSave(): string {
    // Snapshot the REAL running-config so `show startup-config`
    // reflects exactly what was saved (no fabricated content).
    this.startupConfig = Show.showRunningConfig(this.d());
    return 'Building configuration...\n[OK]';
  }

  protected override cmdExit(): string {
    // Router: exit at user mode returns '' (no "Connection closed." like switch)
    this.fsm.mode = this.mode;
    const { newMode, fieldsToCllear } = this.fsm.exit();
    this.mode = newMode;
    this.clearFields(fieldsToCllear);
    return '';
  }

  protected getActiveTrie(): CommandTrie {
    switch (this.mode) {
      case 'user': return this.userTrie;
      case 'privileged': return this.privilegedTrie;
      case 'config': return this.configTrie;
      case 'config-if': return this.configIfTrie;
      case 'config-line': return this.configLineTrie;
      case 'config-dhcp': return this.configDhcpTrie;
      case 'config-dhcp-pool-class': return this.configDhcpPoolClassTrie;
      case 'config-track': return this.configTrackTrie;
      case 'config-ipsla': return this.configIpSlaTrie;
      case 'config-route-map': return this.configRouteMapTrie;
      case 'config-router': return this.configRouterTrie;
      case 'config-router-ospf': return this.configRouterOspfTrie;
      case 'config-router-ospfv3': return this.configRouterOspfv3Trie;
      case 'config-std-nacl': return this.configStdNaclTrie;
      case 'config-ext-nacl': return this.configExtNaclTrie;
      case 'config-ipv6-nacl': return this.configIpv6NaclTrie;
      case 'config-isakmp': return this.configIsakmpTrie;
      case 'config-isakmp-profile': return this.configIsakmpProfileTrie;
      case 'config-tfset': return this.configTfsetTrie;
      case 'config-crypto-map': return this.configCryptoMapTrie;
      case 'config-ipsec-profile': return this.configIpsecProfileTrie;
      case 'config-ikev2-proposal': return this.configIkev2ProposalTrie;
      case 'config-ikev2-policy': return this.configIkev2PolicyTrie;
      case 'config-ikev2-keyring': return this.configIkev2KeyringTrie;
      case 'config-ikev2-keyring-peer': return this.configIkev2KeyringPeerTrie;
      case 'config-ikev2-profile': return this.configIkev2ProfileTrie;
      case 'config-time-range': return this.configTimeRangeTrie;
      case 'config-cmap': return this.configCmapTrie;
      case 'config-pmap': return this.configPmapTrie;
      case 'config-pmap-c': return this.configPmapClassTrie;
      case 'config-cp': return this.configCpTrie;
      case 'config-zone': return this.configZoneTrie;
      case 'config-zone-pair': return this.configZonePairTrie;
      case 'config-radius-server': return this.configRadiusServerTrie;
      case 'config-tacacs-server': return this.configTacacsServerTrie;
      case 'config-aaa-group': return this.configAaaGroupTrie;
      case 'config-ca-trustpoint': return this.configCaTrustpointTrie;
      case 'config-applet': return this.configAppletTrie;
      case 'config-flow-exporter': return this.configFlowExporterTrie;
      case 'config-flow-record': return this.configFlowRecordTrie;
      case 'config-flow-monitor': return this.configFlowMonitorTrie;
      case 'config-archive': return this.configArchiveTrie;
      case 'config-archive-log': return this.configArchiveLogTrie;
      case 'config-dhcp-class': return this.configDhcpClassTrie;
      case 'config-ipv6-dhcp': return this.configIpv6DhcpTrie;
      case 'config-keychain': return this.configKeychainTrie;
      case 'config-keychain-key': return this.configKeychainKeyTrie;
      default: return this.userTrie;
    }
  }

  protected clearFields(fields: string[]): void {
    for (const f of fields) {
      if (f === 'selectedInterface') this.selectedInterface = null;
      if (f === 'selectedDHCPPool') this.selectedDHCPPool = null;
      if (f === 'selectedTrack') this.selectedTrack = null;
      if (f === 'selectedIpSla') this.selectedIpSla = null;
      if (f === 'selectedRouteMap') this.selectedRouteMap = null;
      if (f === 'selectedRoutingProto') this.selectedRoutingProto = null;
      if (f === 'selectedACL') { this.selectedACL = null; this.selectedACLType = null; }
      if (f === 'selectedACLType') this.selectedACLType = null;
      if (f === 'selectedISAKMPPriority') this.selectedISAKMPPriority = null;
      if (f === 'selectedTransformSet') this.selectedTransformSet = null;
      if (f === 'selectedCryptoMap') { this.selectedCryptoMap = null; this.selectedCryptoMapSeq = null; this.selectedCryptoMapIsDynamic = false; }
      if (f === 'selectedCryptoMapSeq') this.selectedCryptoMapSeq = null;
      if (f === 'selectedIPSecProfile') this.selectedIPSecProfile = null;
      if (f === 'selectedIKEv2Proposal') this.selectedIKEv2Proposal = null;
      if (f === 'selectedIKEv2Policy') this.selectedIKEv2Policy = null;
      if (f === 'selectedIKEv2Keyring') this.selectedIKEv2Keyring = null;
      if (f === 'selectedIKEv2KeyringPeer') this.selectedIKEv2KeyringPeer = null;
      if (f === 'selectedIKEv2Profile') this.selectedIKEv2Profile = null;
      if (f === 'selectedTimeRange') this.selectedTimeRange = null;
      if (f === 'selectedKeyChain') this.selectedKeyChain = null;
      if (f === 'selectedKeyChainKey') this.selectedKeyChainKey = null;
      if (f === 'selectedClassMap') this.selectedClassMap = null;
      if (f === 'selectedPolicyMap') this.selectedPolicyMap = null;
      if (f === 'selectedPolicyClass') this.selectedPolicyClass = null;
      if (f === 'selectedZone') this.selectedZone = null;
      if (f === 'selectedZonePair') this.selectedZonePair = null;
      if (f === 'selectedRadiusServer') this.selectedRadiusServer = null;
      if (f === 'selectedTacacsServer') this.selectedTacacsServer = null;
      if (f === 'selectedAaaGroup') this.selectedAaaGroup = null;
      if (f === 'selectedPkiTrustpoint') this.selectedPkiTrustpoint = null;
      if (f === 'selectedApplet') this.selectedApplet = null;
      if (f === 'selectedFlowExporter') this.selectedFlowExporter = null;
      if (f === 'selectedFlowRecord') this.selectedFlowRecord = null;
      if (f === 'selectedFlowMonitor') this.selectedFlowMonitor = null;
    }
  }

  // ─── Router-Specific Command Registration ─────────────────────────

  protected registerDeviceCommands(): void {
    // ── User mode ──
    this.registerShowCommands(this.userTrie);
    this.userTrie.registerGreedy('ping', 'Send echo messages', (args) => {
      return this._handlePing(args);
    });
    this.userTrie.registerGreedy('traceroute', 'Trace route to destination', (args) => {
      return this._handleTraceroute(args);
    });

    // ── Privileged mode ──
    this.registerShowCommands(this.privilegedTrie);
    registerDhcpPrivilegedCommands(this.privilegedTrie, () => this.d());
    buildIPSecPrivilegedCommands(this.privilegedTrie, this);
    registerNATPrivilegedCommands(this.privilegedTrie, () => this.d());

    // ── Config mode ──
    buildConfigCommands(this.configTrie, this);
    buildConfigIfCommands(this.configIfTrie, this);
    buildHsrpInterfaceCommands(this.configIfTrie, this, this.fhrp);
    buildVrrpGlbpInterfaceCommands(this.configIfTrie, this, this.fhrp);
    buildBfdInterfaceCommands(this.configIfTrie, {
      selectedPorts: () => this.selectedPortsForConfigIf(),
      r: () => this.d(),
    });
    buildIgmpInterfaceCommands(this.configIfTrie, {
      selectedPorts: () => this.selectedPortsForConfigIf(),
      r: () => this.d(),
    });
    buildPimInterfaceCommands(this.configIfTrie, {
      selectedPorts: () => this.selectedPortsForConfigIf(),
      r: () => this.d(),
    });
    buildPimGlobalConfigCommands(this.configTrie, { r: () => this.d() });
    buildVxlanInterfaceCommands(this.configIfTrie, {
      selectedInterface: () => this.getSelectedInterface(),
      resolveInterfaceName: (s) => this.resolveInterfaceName(s),
      r: () => this.d(),
    });
    buildPolicyConfig(this.configTrie, this.configRouteMapTrie, this, this.policy);
    buildTrackSlaConfig(this.configTrie, this.configTrackTrie,
      this.configIpSlaTrie, this, this.track, this.ipsla);
    buildACLConfigCommands(this.configTrie, this);
    buildACLInterfaceCommands(this.configIfTrie, this);
    // NAT
    buildNATConfigCommands(this.configTrie, this);
    buildNATInterfaceCommands(this.configIfTrie, this);
    buildConfigDhcpCommands(this.configDhcpTrie, this);
    buildConfigDhcpPoolClassCommands(this.configDhcpPoolClassTrie, this);
    buildConfigDhcpClassCommands(this.configDhcpClassTrie, this);
    buildConfigIpv6DhcpCommands(this.configIpv6DhcpTrie, this);
    registerKeyChainGlobalCommands(this.configTrie, this);
    buildKeyChainSubmode(this.configKeychainTrie, this);
    buildKeyChainKeySubmode(this.configKeychainKeyTrie, this);
    registerKeyChainShowCommands(this.privilegedTrie, this);
    registerKeyChainShowCommands(this.userTrie, this);
    buildRoutingProtoConfig(this.configTrie, this.configRouterTrie, this, this.routingCfg);
    buildNamedStdACLCommands(this.configStdNaclTrie, this);
    buildNamedExtACLCommands(this.configExtNaclTrie, this);
    buildIPv6ACLGlobalCommands(this.configTrie, this);
    buildIPv6ACLModeCommands(this.configIpv6NaclTrie, this);
    // OSPF
    registerOSPFConfigCommands(this.configTrie, this);
    registerOSPFInterfaceCommands(this.configIfTrie, this);
    buildConfigRouterOSPFCommands(this.configRouterOspfTrie, this);
    buildConfigRouterOSPFv3Commands(this.configRouterOspfv3Trie, this);
    // IPSec
    buildIPSecGlobalCommands(this.configTrie, this);
    buildIPSecIfCommands(this.configIfTrie, this);
    buildISAKMPPolicyCommands(this.configIsakmpTrie, this);
    buildISAKMPProfileCommands(this.configIsakmpProfileTrie, this);
    buildTransformSetCommands(this.configTfsetTrie, this);
    buildCryptoMapEntryCommands(this.configCryptoMapTrie, this);
    buildIPSecProfileCommands(this.configIpsecProfileTrie, this);
    buildIKEv2GlobalCommands(this.configTrie, this);
    buildIKEv2ProposalCommands(this.configIkev2ProposalTrie, this);
    buildIKEv2PolicyCommands(this.configIkev2PolicyTrie, this);
    buildIKEv2KeyringCommands(this.configIkev2KeyringTrie, this);
    buildIKEv2KeyringPeerCommands(this.configIkev2KeyringPeerTrie, this);
    buildIKEv2ProfileCommands(this.configIkev2ProfileTrie, this);

    buildSecurityConfigCommands(this.configTrie, this);
    buildSecurityInterfaceCommands(this.configIfTrie, this);
    buildSecuritySubmodeCommands(
      this.configCmapTrie,
      this.configPmapTrie,
      this.configPmapClassTrie,
      this.configCpTrie,
      this.configZoneTrie,
      this.configZonePairTrie,
      this.configTimeRangeTrie,
      this.configRadiusServerTrie,
      this.configTacacsServerTrie,
      this.configAaaGroupTrie,
      this.configCaTrustpointTrie,
      this,
    );
    buildSecurityShowCommands(this.userTrie, () => this.d());
    buildSecurityShowCommands(this.privilegedTrie, () => this.d());

    buildEemNetflowArchiveConfigCommands(this.configTrie, this);
    buildEemAppletSubmode(this.configAppletTrie, this);
    buildFlowExporterSubmode(this.configFlowExporterTrie, this);
    buildFlowRecordSubmode(this.configFlowRecordTrie, this);
    buildFlowMonitorSubmode(this.configFlowMonitorTrie, this);
    buildArchiveSubmode(this.configArchiveTrie, this);
    buildArchiveLogSubmode(this.configArchiveLogTrie, this);
    buildEemNetflowArchiveInterfaceCommands(this.configIfTrie, this);
    buildEemNetflowArchiveShowCommands(this.userTrie, () => this.d());
    buildEemNetflowArchiveShowCommands(this.privilegedTrie, () => this.d());
  }

  // ─── Show Commands (Router-specific) ──────────────────────────────

  private registerShowCommands(trie: CommandTrie): void {
    const getRouter = () => this.d();
    registerRoutingProtoShow(trie, this, this.routingCfg);
    registerHsrpShowCommands(trie, this, this.fhrp);
    registerVrrpGlbpShowCommands(trie, this, this.fhrp);
    registerBfdShowCommands(trie, { r: () => this.d() });
    registerIgmpShowCommands(trie, { r: () => this.d() });
    registerPimShowCommands(trie, { r: () => this.d() });
    registerVxlanShowCommands(trie, { r: () => this.d() });
    registerTrackSlaShow(trie, this, this.track, this.ipsla);
    registerPolicyShow(trie, this.policy);

    // `show logging` — projects the real LoggingConfig (router).
    trie.registerGreedy('show logging', 'Display syslog state', () =>
      this.logging.render());

    // `show tech-support` — real aggregation of the key show outputs.
    trie.register('show tech-support', 'Aggregate diagnostic output', () => {
      const r = this.d();
      const section = (title: string, body: string) =>
        `------------------ ${title} ------------------\n${body}`;
      return [
        section('show version', Show.showVersion(r, this.getChassisProfile())),
        section('show running-config', Show.showRunningConfig(r)),
        section('show ip interface brief', Show.showIpIntBrief(r)),
        section('show ip route', Show.showIpRoute(r)),
        section('show interfaces', Show.showInterfacesAll(r)),
        section('show ip protocols', Show.showIpProtocols(r)),
        section('show logging', this.logging.render()),
      ].join('\n\n');
    });

    trie.register('show bfd summary', 'Display BFD summary', () => ' No BFD sessions configured.');
    trie.register('show table-map', 'Display table-maps', () => ' No table-maps configured.');
    trie.registerGreedy('show mls qos', 'Display MLS QoS', () => ' MLS QoS is disabled.');
    trie.register('show ip nbar protocol-discovery', 'Display NBAR discovery', () => ' NBAR protocol discovery is not enabled.');
    trie.registerGreedy('show queueing interface', 'Display interface queueing', () => ' Interface uses FIFO queueing.');
    trie.registerGreedy('show traffic-shape', 'Display traffic shaping', (args) => {
      if (args[0]?.toLowerCase() === 'statistics') return ' No traffic shaping statistics.';
      return ' No traffic shaping configured.';
    });
    trie.register('show ip policy', 'Display PBR bindings', () => {
      const r = getRouter() as any;
      const m = r._ciscoIfacePolicyRouteMap as Map<string, string> | undefined;
      const local = r._ciscoLocalPolicyRouteMap;
      const rows: string[] = [];
      if (local) rows.push(` Local            ${local}`);
      if (m) for (const [iface, rm] of m) rows.push(` ${iface.padEnd(16)} ${rm}`);
      if (rows.length === 0) return 'Interface        Route map';
      return ['Interface        Route map', ...rows].join('\n');
    });
    trie.register('show ip static route', 'Display static routes', () => Show.showIpRoute(getRouter()));
    trie.registerGreedy('show interfaces accounting', 'Display interface accounting', () => {
      const router = getRouter();
      const ports = router.getPortNames();
      const out: string[] = [];
      for (const p of ports) out.push(`${p}\n  No accounting protocols configured.`);
      return out.join('\n');
    });
    trie.register('show ip interface brief', 'Display interface status summary', () => Show.showIpIntBrief(getRouter()));
    trie.register('show running-config', 'Display running configuration', () => Show.showRunningConfig(getRouter()));
    trie.register('show startup-config', 'Display saved configuration', () =>
      this.startupConfig ?? '% startup-config is not present');
    trie.register('show configuration', 'Display saved configuration', () =>
      this.startupConfig ?? '% startup-config is not present');
    trie.register('show ip rip database', 'Display RIP database', () => Show.showIpRipDatabase(getRouter()));
    // BGP/EIGRP/RIP-extras + show ip protocols come from the
    // RoutingConfigRepository (registerRoutingProtoShow), so they
    // project the real configured process state.
    trie.register('show counters', 'Display traffic counters', () => Show.showCounters(getRouter()));
    trie.register('show ip rip', 'Display RIP information', () => Show.showIpProtocols(getRouter()));

    // DHCP show commands
    registerDhcpShowCommands(trie, getRouter);

    // ACL show commands
    registerACLShowCommands(trie, getRouter);

    // OSPF show commands
    registerOSPFShowCommands(trie, getRouter);

    // IPSec show commands
    registerIPSecShowCommands(trie, getRouter);

    // NAT show commands
    registerNATShowCommands(trie, getRouter);

    // show running-config interface <name>
    trie.registerGreedy('show running-config interface', 'Display interface running config', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const ifName = resolveInterfaceName(getRouter(), args.join(' '));
      if (!ifName) return `% Invalid interface`;
      return Show.showRunningConfigInterface(getRouter(), ifName);
    });

    trie.register('show version', 'Display system hardware and software status', () => Show.showVersion(getRouter(), this.getChassisProfile()));

    // `show interface[s] [<name>|description|status|summary]`.
    // Registered under both the singular and plural IOS spellings;
    // dispatch logic lives in one place (single source of truth).
    const showInterfaceCmd = (args: string[]): string => {
      const sub = (args[0] || '').toLowerCase();
      if (args.length === 0) return Show.showInterfacesAll(getRouter());
      if (sub === 'description') return Show.showInterfacesDescription(getRouter());
      if (sub === 'status') return Show.showInterfacesStatus(getRouter());
      if (sub === 'summary') return Show.showInterfacesSummary(getRouter());
      if (sub === 'trunk') return Show.showInterfacesTrunk(getRouter());
      const last = args[args.length - 1]?.toLowerCase();
      const isViewModifier = last === 'accounting' || last === 'stats' || last === 'switchport';
      const ifPart = isViewModifier ? args.slice(0, -1).join(' ') : args.join(' ');
      const ifName = resolveInterfaceName(getRouter(), ifPart);
      if (!ifName) return `% Invalid input detected at '^' marker.\nshow interface ${args.join(' ')}\n     ^`;
      if (last === 'accounting') return Show.showInterfaceAccounting(getRouter(), ifName);
      if (last === 'stats') return Show.showInterfaceStats(getRouter(), ifName);
      if (last === 'switchport') return Show.showInterfaceSwitchport(getRouter(), ifName);
      return Show.showInterface(getRouter(), ifName);
    };
    trie.registerGreedy('show interfaces', 'Display interface status', showInterfaceCmd);
    trie.register('show vlans', 'Display VLANs (router)', () => Show.showVlansRouter(getRouter()));
    trie.registerGreedy('show ipv6 interface', 'Display IPv6 interface state', (args) => {
      const sub = (args[0] || '').toLowerCase();
      if (sub === '' || sub === 'brief') return Show.showIpv6InterfaceBrief(getRouter());
      const ifName = resolveInterfaceName(getRouter(), args.join(' '));
      if (!ifName) return `% Invalid input detected at '^' marker.`;
      return Show.showIpv6Interface(getRouter(), ifName);
    });

    // `show ip interface[s] [brief|<name>]` — verbose/all + brief.
    const showIpInterfaceCmd = (args: string[]): string => {
      const sub = (args[0] || '').toLowerCase();
      if (args.length === 0) return Show.showIpInterfaceAll(getRouter());
      if (sub === 'brief') return Show.showIpIntBrief(getRouter());
      const ifName = resolveInterfaceName(getRouter(), args.join(' '));
      if (!ifName) return `% Invalid input detected at '^' marker.`;
      return Show.showInterface(getRouter(), ifName);
    };
    trie.registerGreedy('show ip interface', 'Display IP interface status', showIpInterfaceCmd);
  }

  // ─── Ping Command ────────────────────────────────────────────────

  private _handlePing(args: string[]): string {
    const parsed = parsePingArgs(args);
    if (parsed.error) return parsed.error;

    const router = this.d();
    let sourceIP = parsed.sourceIP;
    if (sourceIP) {
      const resolved = this._resolveSourceIP(router, sourceIP);
      if (resolved) sourceIP = resolved;
    }

    const targetIP = new IPAddress(parsed.target);
    this._pendingAsync = router
      .executePingSequence(targetIP, parsed.count, parsed.timeoutMs, sourceIP ?? undefined)
      .then(results => formatCiscoPing(parsed.target, parsed.count, parsed.timeoutMs, results, parsed.sizeBytes));

    return '';
  }

  private _handleTraceroute(args: string[]): string {
    if (args.length === 0) {
      return '% Traceroute requires a target IP address.';
    }

    let target = '';
    let maxHops = 30;
    let timeoutMs = 2000;
    let probesPerHop = 3;

    let i = 0;
    target = args[i++]?.trim() || '';

    while (i < args.length) {
      const kw = args[i]?.toLowerCase();
      if (kw === 'ttl' && args[i + 1]) {
        const n = parseInt(args[i + 1], 10);
        if (!isNaN(n) && n > 0) maxHops = n;
        i += 2;
      } else if (kw === 'timeout' && args[i + 1]) {
        const n = parseInt(args[i + 1], 10);
        if (!isNaN(n) && n > 0) timeoutMs = n * 1000;
        i += 2;
      } else if (kw === 'probe' && args[i + 1]) {
        const n = parseInt(args[i + 1], 10);
        if (!isNaN(n) && n > 0) probesPerHop = n;
        i += 2;
      } else {
        i++;
      }
    }

    if (!target) return '% Traceroute requires a target IP address.';

    const ipMatch = target.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipMatch) return `% Unrecognized host or address, or protocol not running.`;
    const octets = [+ipMatch[1], +ipMatch[2], +ipMatch[3], +ipMatch[4]];
    if (octets.some(o => o > 255)) return `% Unrecognized host or address, or protocol not running.`;

    const targetIP = new IPAddress(target);
    const router = this.d();

    this._pendingAsync = router.executeTraceroute(targetIP, maxHops, timeoutMs, probesPerHop).then(hops => {
      return this._formatCiscoTraceroute(target, maxHops, hops);
    });

    return '';
  }

  private _formatCiscoTraceroute(
    target: string,
    maxHops: number,
    hops: Array<{ hop: number; ip?: string; rttMs?: number; timeout: boolean; unreachable?: boolean; probes?: Array<{ responded: boolean; rttMs?: number; ip?: string; unreachable?: boolean }> }>,
  ): string {
    const lines: string[] = [
      'Type escape sequence to abort.',
      `Tracing the route to ${target}`,
      `VRF info: (vrf in name/id, vrf out name/id)`,
      '',
    ];

    if (hops.length === 0) {
      lines.push(`% Network is unreachable`);
      return lines.join('\n');
    }

    for (const hop of hops) {
      if (hop.timeout && (!hop.probes || hop.probes.every(p => !p.responded))) {
        lines.push(`  ${hop.hop}  *  *  *`);
        continue;
      }

      let annotation = '';
      if (hop.unreachable) annotation = ' !N';

      if (hop.probes && hop.probes.length > 0) {
        const parts: string[] = [];
        for (const probe of hop.probes) {
          if (!probe.responded) {
            parts.push('*');
          } else {
            parts.push(`${Math.round(probe.rttMs ?? 0)} msec`);
          }
        }
        lines.push(`  ${hop.hop} ${hop.ip}  ${parts.join(' ')}${annotation}`);
      } else {
        const ms = Math.round(hop.rttMs ?? 0);
        lines.push(`  ${hop.hop} ${hop.ip}  ${ms} msec${annotation}`);
      }
    }

    return lines.join('\n');
  }

  private _resolveSourceIP(router: any, source: string): string | null {
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(source)) return source;
    const ports = router._getPortsInternal?.() as Map<string, any> | undefined;
    if (!ports) return null;
    const port = ports.get(source);
    if (port) {
      const ip = port.getIPAddress?.();
      return ip ? ip.toString() : null;
    }
    const resolved = resolveInterfaceName(router, source);
    if (resolved) {
      const rPort = ports.get(resolved);
      if (rPort) {
        const ip = rPort.getIPAddress?.();
        return ip ? ip.toString() : null;
      }
    }
    return null;
  }
}
