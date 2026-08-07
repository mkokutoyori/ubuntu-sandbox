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
import { CommandTrie, setInvalidInputPromptWidth, formatInvalidInput, formatInvalidInputAt } from './CommandTrie';
import { IPAddress, SubnetMask } from '../../core/types';
import { parsePingArgs, formatCiscoPing } from './cisco/ciscoPing';
import { registerLoggingShowCommands } from './cisco/CiscoLoggingCommands';
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
import { FhrpRepository } from '../inspection/config/FhrpRepository';
import { buildTrackConfigCommands, registerTrackShowCommands } from './cisco/CiscoTrackCommands';
import { KeyChainRepository } from '../inspection/config/KeyChainRepository';
import {
  buildIpSlaConfigCommands, registerIpSlaTypeSubModes,
} from './cisco/CiscoIpSlaCommands';
import {
  registerIpSlaShowCommands, registerIpSlaClearCommands, registerIpSlaDebugCommands,
} from './cisco/CiscoIpSlaShowCommands';
import { describeCiscoArguments } from './cisco/ciscoArgumentHelp';
import { renderStartupConfig } from './cisco/ciscoConfigSerializer';
import { PolicyRepository } from '../inspection/config/PolicyRepository';
import {
  buildPolicyConfig, registerPolicyShow,
} from './cisco/CiscoPolicyCommands';

// Extracted command modules
import * as Show from './cisco/CiscoShowCommands';
import { showProcessesCpu } from './cisco/CiscoCommonShow';
import { showNATTranslations, showNATStatistics } from './cisco/CiscoNATCommands';
import { showIpOspfNeighbor } from './cisco/CiscoOspfCommands';
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
  buildIPSecGlobalCommands, buildISAKMPPolicyCommands, buildISAKMPProfileCommands, buildISAKMPKeyringCommands,
  buildTransformSetCommands, buildCryptoMapEntryCommands,
  buildIPSecProfileCommands, buildIPSecIfCommands,
  buildIPSecPrivilegedCommands,
} from './cisco/CiscoIPSecIKEv1Commands';
import {
  buildIKEv2GlobalCommands, buildIKEv2ProposalCommands,
  buildIKEv2PolicyCommands, buildIKEv2KeyringCommands,
  buildIKEv2KeyringPeerCommands, buildIKEv2ProfileCommands,
} from './cisco/CiscoIPSecIKEv2Commands';
import {
  buildGdoiGlobalCommands, buildGdoiGroupCommands,
} from './cisco/CiscoGdoiCommands';
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
import { iosShortInterfaceName } from '@/network/devices/inspection/InterfaceStatusView';

const HORS_PLATEFORME_ISR: ReadonlySet<string> = new Set(['vxlan', 'nve', 'mls']);

export class CiscoIOSShell extends CiscoShellBase<Router> implements IRouterShell, CiscoShellContext, CiscoACLShellContext {
  // ─── Router-specific state ───────────────────────────────────────
  private selectedInterface: string | null = null;
  /** Real config-driven HSRP/VRRP/GLBP state (router-only; L2 switches none). */
  private readonly fhrp = new FhrpRepository();
  private readonly keyChains = new KeyChainRepository();
  getKeyChains(): KeyChainRepository { return this.keyChains; }
  private readonly policy = new PolicyRepository();
  private readonly routingCfg = new RoutingConfigRepository();
  /** Lu par le sérialiseur de configuration (`showRunningConfig`). */
  getRoutingConfig(): RoutingConfigRepository { return this.routingCfg; }
  getPolicyRepo(): PolicyRepository { return this.policy; }
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
  private selectedISAKMPKeyring: string | null = null;
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
  private selectedGdoiGroup: string | null = null;

  // ─── FSM (router-specific mode hierarchy) ────────────────────────
  protected readonly fsm = new CLIStateMachine<CiscoShellMode>('user', CISCO_IOS_MODES, 'user', 'privileged');

  // ─── Additional tries (beyond base's user/privileged/config/configIf) ─
  private configDhcpTrie = new CommandTrie();
  private configDhcpPoolClassTrie = new CommandTrie();
  private configTrackTrie = new CommandTrie();
  private configVrfTrie = new CommandTrie();
  private configVlanTrie = new CommandTrie();
  private selectedVRF: string | null = null;
  private selectedVLAN: number | null = null;
  private configIpSlaTrie = new CommandTrie();
  private configIpSlaHttpRawTrie = new CommandTrie();
  private readonly configIpSlaTypeTries: Record<string, CommandTrie> = {
    'config-ipsla-echo': new CommandTrie(),
    'config-ipsla-icmpjitter': new CommandTrie(),
    'config-ipsla-jitter': new CommandTrie(),
    'config-ipsla-udp': new CommandTrie(),
    'config-ipsla-tcp': new CommandTrie(),
    'config-ipsla-http': new CommandTrie(),
    'config-ipsla-dns': new CommandTrie(),
    'config-ipsla-pathecho': new CommandTrie(),
  };
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
  private configKeyringTrie = new CommandTrie();
  private configTfsetTrie = new CommandTrie();
  private configCryptoMapTrie = new CommandTrie();
  private configIpsecProfileTrie = new CommandTrie();
  private configIkev2ProposalTrie = new CommandTrie();
  private configIkev2PolicyTrie = new CommandTrie();
  private configIkev2KeyringTrie = new CommandTrie();
  private configIkev2KeyringPeerTrie = new CommandTrie();
  private configIkev2ProfileTrie = new CommandTrie();
  private configGdoiGroupTrie = new CommandTrie();
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
    // `registerShowCommands` est appelé pour plusieurs tries ; le debug
    // est privilégié seulement, donc enregistré ici une seule fois.
    registerIpSlaDebugCommands(this.privilegedTrie, this);
    // Après TOUS les enregistrements : `describeArgs` attache les
    // spécifications à des nœuds existants, il n'en crée pas.
    describeCiscoArguments({
      config: this.configTrie,
      configIf: this.configIfTrie,
      configLine: this.configLineTrie,
      configDhcp: this.configDhcpTrie,
      configRouter: this.configRouterTrie,
      configRouterOspf: this.configRouterOspfTrie,
      configStdNacl: this.configStdNaclTrie,
      configExtNacl: this.configExtNaclTrie,
      privileged: this.privilegedTrie,
    });
  }

  // ─── IRouterShell ────────────────────────────────────────────────

  getOSType(): string { return 'cisco-ios'; }

  private ipSlaOwner: Router | null = null;

  execute(router: Router, rawInput: string): string | Promise<string> {
    this.ipSlaOwner = router;
    setInvalidInputPromptWidth(this.buildDevicePrompt(router).length);
    router.setRouteTrackResolver((trackId) =>
      router.getTrackService().isUp(parseInt(trackId, 10)));
    this.attachDebugSource((router as unknown as { getDebugService?: () => { subscribe(l: (line: string) => void): () => void } }).getDebugService?.());
    if (rawInput.trim() === '' && !this.isCollectingBanner()) return this.drainDebugConsole();
    return this.executeOnDevice(router, rawInput);
  }

  getPrompt(router: Router): string {
    return this.buildDevicePrompt(router);
  }

  // ─── CiscoShellContext Implementation ────────────────────────────

  r(): Router { return this.d(); }

  setMode(mode: CiscoShellMode): void { this.mode = mode; }

  /**
   * A privilege-15 login is already in privileged EXEC on real IOS; a
   * lower level opens in user EXEC. The level travels with the mode —
   * setting one without the other made `show privilege` disagree with the
   * prompt the same session was showing.
   */
  beginExecSession(level: number, user?: string): void {
    this.currentPrivilegeLevel = level;
    this.setMode(level >= 15 ? 'privileged' : 'user');
    if (user) this.configSessionLabel = user;
  }

  override getMode(): CiscoShellMode { return this.mode as CiscoShellMode; }

  getSelectedInterface(): string | null { return this.selectedInterface; }
  setSelectedInterface(iface: string | null): void { this.selectedInterface = iface; }

  getSelectedDHCPPool(): string | null { return this.selectedDHCPPool; }
  setSelectedDHCPPool(pool: string | null): void { this.selectedDHCPPool = pool; }
  setSelectedVRF(name: string | null): void { this.selectedVRF = name; }
  setSelectedVLAN(id: number | null): void { this.selectedVLAN = id; }

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
  getSelectedISAKMPKeyring(): string | null { return this.selectedISAKMPKeyring; }
  setSelectedISAKMPKeyring(k: string | null): void { this.selectedISAKMPKeyring = k; }
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
  getSelectedGdoiGroup(): string | null { return this.selectedGdoiGroup; }
  setSelectedGdoiGroup(g: string | null): void { this.selectedGdoiGroup = g; }

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
      selectedInterfaceRange: [],
      selectedVlan: null,
      selectedArpAcl: null,
      selectedAccessMap: null,
      selectedMqcName: null,
      selectedPortGroup: null,
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
      terminalMonitorExplicit: this.terminalMonitorExplicit,
      // Cisco IOS has no separate "terminal debugging" toggle — `terminal
      // monitor` alone gates whether debug/log output reaches this vty
      // (unlike Huawei VRP, which distinguishes the two). Mirror it here
      // purely to satisfy the shared VtySnapshot shape.
      terminalDebugging: this.terminalMonitor,
      privilegeLevel: this.currentPrivilegeLevel,
      historySize: 10,
      cmdHistory: this.cmdHistory,
    };
  }

  /** Apply a session's snapshot onto this shell instance. */
  applyVtyState(s: import('./vty/CliShellSession').VtySnapshot): void {
    this.mode = s.mode as CiscoShellMode;
    this.currentPrivilegeLevel = s.privilegeLevel;
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
    this.terminalMonitorExplicit = s.terminalMonitorExplicit ?? false;
    this.cmdHistory = s.cmdHistory;
  }

  // ─── Abstract Method Implementations ─────────────────────────────

  protected getPromptMap(): PromptMap { return CISCO_IOS_PROMPTS; }

  protected override getChassisProfile(): import('./cisco/CiscoCommonShow').CiscoChassisProfile {
    return 'router-isr2911';
  }

  private startupAliases: ReturnType<typeof this.aliases.snapshot> | null = null;

  /** `show running-config` text — source for `write memory`/NVRAM (Router.getRunningConfig). */
  getRunningConfigText(router: Router): string {
    return Show.showRunningConfig(router);
  }

  /** Re-apply saved config text onto live router state (`copy start run`, `reload`). */
  applyConfigText(router: Router, text: string): void {
    let curIface: string | null = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line === '!' ||
          line.startsWith('Building config') || line.startsWith('Current configuration')) continue;
      let g: RegExpMatchArray | null;
      if (!/^\s/.test(raw)) {
        curIface = null;
        if ((g = line.match(/^hostname\s+(\S+)/))) {
          router._setHostnameInternal(g[1]);
        } else if ((g = line.match(/^interface\s+(\S+)/))) {
          curIface = g[1];
        } else if ((g = line.match(/^ip route\s+(\S+)\s+(\S+)\s+(\S+)/))) {
          try {
            const mask = new SubnetMask(g[2]);
            const nextHop = new IPAddress(g[3]);
            if (g[1] === '0.0.0.0' && g[2] === '0.0.0.0') router.setDefaultRoute(nextHop);
            else router.addStaticRoute(new IPAddress(g[1]), mask, nextHop);
          } catch { /* malformed saved line — skip like real IOS would reject it */ }
        }
        continue;
      }
      if (!curIface) continue;
      if ((g = line.match(/^description\s+(.+)/))) {
        router.setInterfaceDescription(curIface, g[1]);
      } else if ((g = line.match(/^ip address\s+(\S+)\s+(\S+)(\s+secondary)?/))) {
        try {
          router.configureInterface(curIface, new IPAddress(g[1]), new SubnetMask(g[2]), !!g[3]);
        } catch { /* malformed saved line — skip */ }
      } else if (line === 'shutdown') {
        router.getPort(curIface)?.setAdminShutdown(true);
      } else if (line === 'no shutdown') {
        router.getPort(curIface)?.setAdminShutdown(false);
      }
    }
  }

  protected onSave(): string {
    this.d().writeMemory();
    this.startupAliases = this.aliases.snapshot();
    this.archiveAfterSave();
    return 'Building configuration...\n[OK]';
  }

  protected override onErase(): void {
    super.onErase();
    this.startupAliases = null;
  }

  private reloadFromNvram(device: Router): void {
    device._resetConfigurableStateForReload();
    device._restoreStartupConfig();
  }

  protected override performImmediateReload(): string {
    const out = super.performImmediateReload();
    this.reloadFromNvram(this.d());
    if (this.startupAliases) this.aliases.restore(this.startupAliases);
    return out;
  }

  protected override performScheduledReload(device: Router): void {
    super.performScheduledReload(device);
    this.reloadFromNvram(device);
    if (this.startupAliases) this.aliases.restore(this.startupAliases);
  }

  protected override cmdExit(): string {
    if (this.mode === 'user') { this.terminalMonitor = false; return 'Connection closed.'; }
    const wasConfig = this.isConfigMode();
    this.fsm.mode = this.mode as CiscoShellMode;
    const { newMode, fieldsToCllear } = this.fsm.exit();
    this.mode = newMode;
    this.clearFields(fieldsToCllear);
    this.announceConfigExit(wasConfig);
    return '';
  }

  protected getActiveTrie(): CommandTrie {
    switch (this.mode) {
      case 'user': return this.userTrie;
      case 'privileged': return this.privilegedTrie;
      case 'config': return this.configTrie;
      case 'config-if': return this.configIfTrie;
      case 'config-subif': return this.configIfTrie;
      case 'config-line': return this.configLineTrie;
      case 'config-dhcp': return this.configDhcpTrie;
      case 'config-dhcp-pool-class': return this.configDhcpPoolClassTrie;
      case 'config-track': return this.configTrackTrie;
      case 'config-vrf': return this.configVrfTrie;
      case 'config-vlan': return this.configVlanTrie;
      case 'config-ipsla': return this.configIpSlaTrie;
      case 'config-ipsla-http-raw': return this.configIpSlaHttpRawTrie;
      case 'config-ipsla-echo':
      case 'config-ipsla-icmpjitter':
      case 'config-ipsla-jitter':
      case 'config-ipsla-udp':
      case 'config-ipsla-tcp':
      case 'config-ipsla-http':
      case 'config-ipsla-dns':
      case 'config-ipsla-pathecho':
        return this.configIpSlaTypeTries[this.mode];
      case 'config-route-map': return this.configRouteMapTrie;
      case 'config-router': return this.configRouterTrie;
      case 'config-router-af': return this.configRouterTrie;
      case 'config-router-ospf': return this.configRouterOspfTrie;
      case 'config-router-ospfv3': return this.configRouterOspfv3Trie;
      case 'config-std-nacl': return this.configStdNaclTrie;
      case 'config-ext-nacl': return this.configExtNaclTrie;
      case 'config-ipv6-nacl': return this.configIpv6NaclTrie;
      case 'config-isakmp': return this.configIsakmpTrie;
      case 'config-isakmp-profile': return this.configIsakmpProfileTrie;
      case 'config-keyring': return this.configKeyringTrie;
      case 'config-tfset': return this.configTfsetTrie;
      case 'config-crypto-map': return this.configCryptoMapTrie;
      case 'config-ipsec-profile': return this.configIpsecProfileTrie;
      case 'config-ikev2-proposal': return this.configIkev2ProposalTrie;
      case 'config-ikev2-policy': return this.configIkev2PolicyTrie;
      case 'config-ikev2-keyring': return this.configIkev2KeyringTrie;
      case 'config-ikev2-keyring-peer': return this.configIkev2KeyringPeerTrie;
      case 'config-ikev2-profile': return this.configIkev2ProfileTrie;
      case 'config-gdoi-group': return this.configGdoiGroupTrie;
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

  /**
   * Une entrée `ip sla <n>` quittée SANS type d'opération n'existe pas
   * sur IOS : la configuration est abandonnée. La garder produisait une
   * opération « not configured » qui survivait dans `show ip sla
   * summary`, `configuration` et la running-config — et qui, au passage,
   * cassait l'alignement du tableau du résumé.
   */
  private discardUnconfiguredIpSla(): void {
    // `exit` est traité AVANT que `executeOnDevice` ne pose la référence
    // d'équipement, d'où cette référence posée par `execute` : `d()`
    // lèverait ici.
    const router = this.ipSlaOwner;
    if (this.selectedIpSla === null || !router) return;
    const engine = router.getIpSlaEngine();
    const runtime = engine.getOperation(this.selectedIpSla);
    if (runtime && runtime.config.type === 'unknown') engine.removeOperation(this.selectedIpSla);
  }

  protected clearFields(fields: string[]): void {
    for (const f of fields) {
      if (f === 'selectedInterface') this.selectedInterface = null;
      if (f === 'selectedDHCPPool') this.selectedDHCPPool = null;
      if (f === 'selectedTrack') this.selectedTrack = null;
      if (f === 'selectedIpSla') { this.discardUnconfiguredIpSla(); this.selectedIpSla = null; }
      if (f === 'selectedRouteMap') this.selectedRouteMap = null;
      if (f === 'selectedRoutingProto') this.selectedRoutingProto = null;
      if (f === 'selectedACL') { this.selectedACL = null; this.selectedACLType = null; }
      if (f === 'selectedACLType') this.selectedACLType = null;
      if (f === 'selectedISAKMPPriority') this.selectedISAKMPPriority = null;
      if (f === 'selectedISAKMPProfile') this.selectedISAKMPProfile = null;
      if (f === 'selectedISAKMPKeyring') this.selectedISAKMPKeyring = null;
      if (f === 'selectedTransformSet') this.selectedTransformSet = null;
      if (f === 'selectedCryptoMap') { this.selectedCryptoMap = null; this.selectedCryptoMapSeq = null; this.selectedCryptoMapIsDynamic = false; }
      if (f === 'selectedCryptoMapSeq') this.selectedCryptoMapSeq = null;
      if (f === 'selectedIPSecProfile') this.selectedIPSecProfile = null;
      if (f === 'selectedIKEv2Proposal') this.selectedIKEv2Proposal = null;
      if (f === 'selectedIKEv2Policy') this.selectedIKEv2Policy = null;
      if (f === 'selectedIKEv2Keyring') this.selectedIKEv2Keyring = null;
      if (f === 'selectedIKEv2KeyringPeer') this.selectedIKEv2KeyringPeer = null;
      if (f === 'selectedIKEv2Profile') this.selectedIKEv2Profile = null;
      if (f === 'selectedGdoiGroup') this.selectedGdoiGroup = null;
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
    buildTrackConfigCommands(this.configTrie, this.configTrackTrie, this);
    buildIpSlaConfigCommands(this.configTrie, this.configIpSlaTrie,
      this.configIpSlaHttpRawTrie, this);
    registerIpSlaTypeSubModes(this.configIpSlaTypeTries, this.configIpSlaHttpRawTrie, this);
    buildACLConfigCommands(this.configTrie, this);
    buildACLInterfaceCommands(this.configIfTrie, this);
    // NAT
    buildNATConfigCommands(this.configTrie, this);
    buildNATInterfaceCommands(this.configIfTrie, this);
    this.configIfTrie.registerGreedy('ip vrf forwarding', 'Bind interface to a VRF', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const vrfName = args[0];
      const ifName = this.getSelectedInterface?.();
      if (!ifName) return '% No interface selected.';
      const router = this.d() as unknown as { _vrfs?: Map<string, { name: string; interfaces: Set<string> }>; _ifaceVrf?: Map<string, string> };
      if (!router._vrfs?.has(vrfName)) return `% VRF ${vrfName} not configured`;
      router._vrfs.get(vrfName)!.interfaces.add(ifName);
      (router._ifaceVrf ??= new Map()).set(ifName, vrfName);
      for (const [name, vrf] of router._vrfs) {
        if (name !== vrfName) vrf.interfaces.delete(ifName);
      }
      return '';
    });
    this.configIfTrie.registerGreedy('no ip vrf forwarding', 'Unbind interface from VRF', (args) => {
      const ifName = this.getSelectedInterface?.();
      if (!ifName) return '% No interface selected.';
      const router = this.d() as unknown as { _vrfs?: Map<string, { name: string; interfaces: Set<string> }>; _ifaceVrf?: Map<string, string> };
      const bound = router._ifaceVrf?.get(ifName);
      if (bound) {
        router._vrfs?.get(bound)?.interfaces.delete(ifName);
        router._ifaceVrf?.delete(ifName);
      }
      void args;
      return '';
    });
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

    this.configTrie.registerGreedy('vlan', 'VLAN configuration', (args) => {
      const id = parseInt(args[0] ?? '', 10);
      if (!Number.isFinite(id) || id < 1 || id > 4094) return "% Invalid input detected at '^' marker.";
      this.selectedVLAN = id;
      const r = this.d() as unknown as { _vlans?: Map<number, { id: number; name?: string }> };
      const vlans = r._vlans ??= new Map();
      if (!vlans.has(id)) vlans.set(id, { id });
      this.mode = 'config-vlan';
      return '';
    });
    this.configVlanTrie.registerGreedy('name', 'VLAN name', (args) => {
      const r = this.d() as unknown as { _vlans?: Map<number, { id: number; name?: string }> };
      const name = args.join(' ');
      if (!name) return '% Incomplete command.';
      const bareName = name.replace(/^"|"$/g, '');
      if (bareName.length > 32) return "% Invalid input detected at '^' marker.";
      if (this.selectedVLAN != null) {
        const v = r._vlans?.get(this.selectedVLAN);
        if (v) v.name = bareName;
      }
      return '';
    });

    this.configVrfTrie.registerGreedy('rd', 'Route distinguisher', (args) => {
      const rd = args.join(' ').trim();
      const m = /^(\d+):(\d+)$/.exec(rd);
      if (!m) return "% Invalid input detected at '^' marker.";
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a > 4294967295 || b > 4294967295) {
        return "% Invalid input detected at '^' marker.";
      }
      const r = this.d() as unknown as { _vrfs?: Map<string, { name: string; rd?: string }> };
      if (this.selectedVRF != null) {
        const v = r._vrfs?.get(this.selectedVRF);
        if (v) v.rd = rd;
      }
      return '';
    });
    this.configVrfTrie.registerGreedy('route-target', 'Route target', () => '');
    this.configVrfTrie.registerGreedy('description', 'Description', () => '');
    // IPSec
    buildIPSecGlobalCommands(this.configTrie, this);
    buildIPSecIfCommands(this.configIfTrie, this);
    buildISAKMPPolicyCommands(this.configIsakmpTrie, this);
    buildISAKMPProfileCommands(this.configIsakmpProfileTrie, this);
    buildISAKMPKeyringCommands(this.configKeyringTrie, this);
    buildTransformSetCommands(this.configTfsetTrie, this);
    buildCryptoMapEntryCommands(this.configCryptoMapTrie, this);
    buildIPSecProfileCommands(this.configIpsecProfileTrie, this);
    buildIKEv2GlobalCommands(this.configTrie, this);
    buildIKEv2ProposalCommands(this.configIkev2ProposalTrie, this);
    buildIKEv2PolicyCommands(this.configIkev2PolicyTrie, this);
    buildIKEv2KeyringCommands(this.configIkev2KeyringTrie, this);
    buildIKEv2KeyringPeerCommands(this.configIkev2KeyringPeerTrie, this);
    buildIKEv2ProfileCommands(this.configIkev2ProfileTrie, this);
    buildGdoiGlobalCommands(this.configTrie, this);
    buildGdoiGroupCommands(this.configGdoiGroupTrie, this);

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
    registerTrackShowCommands(trie, this);
    registerIpSlaShowCommands(trie, this);
    registerIpSlaClearCommands(trie, this);
    registerPolicyShow(trie, this.policy);
    trie.pruneSubtreeChildren('show', HORS_PLATEFORME_ISR);

    registerLoggingShowCommands(trie, this.loggingCommandContext());

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
        section('show processes cpu', showProcessesCpu()),
        section('show ip nat translations', showNATTranslations(getRouter())),
        section('show ip nat statistics', showNATStatistics(getRouter())),
        section('show ip ospf neighbor', showIpOspfNeighbor(getRouter())),
        section('show ip dhcp binding', getRouter()._getDHCPServerInternal().formatBindingsShow()),
        section('show logging', this.logging.render()),
      ].join('\n\n');
    });

    trie.register('show bfd summary', 'Display BFD summary', () => ' No BFD sessions configured.');
    trie.register('show table-map', 'Display table-maps', () => ' No table-maps configured.');
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
      // Une colonne alignée sur l'en-tête, et le nom abrégé qu'IOS emploie
      // ici : les lignes commençaient par une espace et débordaient de la
      // colonne annoncée, donc rien ne s'alignait sur l'en-tête.
      const COL = 15;
      const head = `${'Interface'.padEnd(COL)}Route map`;
      const rows: string[] = [];
      if (local) rows.push(`${'Local'.padEnd(COL)}${local}`);
      if (m) {
        for (const [iface, rm] of m) {
          rows.push(`${iosShortInterfaceName(iface).padEnd(COL)}${rm}`);
        }
      }
      return [head, ...rows].join('\n');
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
    // `show startup-config` lit la NVRAM : son en-tête annonce
    // l'occupation, pas « Building configuration… » qui appartient à
    // `show running-config`.
    const startupConfig = () => {
      const snapshot = getRouter().getStartupConfigSnapshot();
      if (snapshot === null) return '% startup-config is not present';
      return renderStartupConfig(snapshot, this.fs().nvramTotalBytes());
    };
    trie.register('show startup-config', 'Display saved configuration', startupConfig);
    trie.register('show configuration', 'Display saved configuration', startupConfig);
    trie.register('show ip rip database', 'Display RIP database',
      () => Show.showIpRipDatabase(getRouter(), this.routingCfg.rip.autoSummary));
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
      if (sub === 'status') return formatInvalidInput('show interfaces '.length);
      if (sub === 'summary') return Show.showInterfacesSummary(getRouter());
      if (sub === 'trunk') return formatInvalidInput('show interfaces '.length);
      const last = args[args.length - 1]?.toLowerCase();
      const isViewModifier = last === 'accounting' || last === 'stats'
        || last === 'switchport' || last === 'rate-limit';
      const ifPart = isViewModifier ? args.slice(0, -1).join(' ') : args.join(' ');
      const ifName = resolveInterfaceName(getRouter(), ifPart);
      if (!ifName) {
        const line = `show interface ${args.join(' ')}`;
        // `ifPart` (the invalid argument) always starts right after the
        // fixed "show interface " prefix, regardless of the view modifier.
        const marker = ' '.repeat('show interface '.length) + '^';
        return formatInvalidInputAt(marker);
      }
      if (last === 'accounting') return Show.showInterfaceAccounting(getRouter(), ifName);
      if (last === 'stats') return Show.showInterfaceStats(getRouter(), ifName);
      if (last === 'switchport') return Show.showInterfaceSwitchport(getRouter(), ifName);
      if (last === 'rate-limit') return Show.showInterfaceRateLimit(getRouter(), ifName);
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
