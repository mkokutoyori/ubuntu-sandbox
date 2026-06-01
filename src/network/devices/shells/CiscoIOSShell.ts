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
  buildTrackSlaConfig, registerTrackSlaShow,
} from './cisco/CiscoTrackSlaCommands';
import { FhrpRepository } from '../inspection/config/FhrpRepository';
import { TrackRepository } from '../inspection/config/TrackRepository';
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
  buildConfigDhcpCommands,
  registerDhcpShowCommands,
  registerDhcpPrivilegedCommands,
} from './cisco/CiscoDhcpCommands';
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
  buildIPSecGlobalCommands, buildISAKMPPolicyCommands,
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
  buildNATConfigCommands, buildNATInterfaceCommands,
  registerNATPrivilegedCommands, registerNATShowCommands,
} from './cisco/CiscoNATCommands';

export class CiscoIOSShell extends CiscoShellBase<Router> implements IRouterShell, CiscoShellContext, CiscoACLShellContext {
  // ─── Router-specific state ───────────────────────────────────────
  private selectedInterface: string | null = null;
  /** Real config-driven HSRP/VRRP/GLBP state (router-only; L2 switches none). */
  private readonly fhrp = new FhrpRepository();
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
  private configTfsetTrie = new CommandTrie();
  private configCryptoMapTrie = new CommandTrie();
  private configIpsecProfileTrie = new CommandTrie();
  private configIkev2ProposalTrie = new CommandTrie();
  private configIkev2PolicyTrie = new CommandTrie();
  private configIkev2KeyringTrie = new CommandTrie();
  private configIkev2KeyringPeerTrie = new CommandTrie();
  private configIkev2ProfileTrie = new CommandTrie();

  constructor() {
    super();
    this.initializeCommands();
  }

  // ─── IRouterShell ────────────────────────────────────────────────

  getOSType(): string { return 'cisco-ios'; }

  execute(router: Router, rawInput: string): string | Promise<string> {
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
    this.cmdHistory = s.cmdHistory;
  }

  // ─── Abstract Method Implementations ─────────────────────────────

  protected getPromptMap(): PromptMap { return CISCO_IOS_PROMPTS; }

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
      case 'config-tfset': return this.configTfsetTrie;
      case 'config-crypto-map': return this.configCryptoMapTrie;
      case 'config-ipsec-profile': return this.configIpsecProfileTrie;
      case 'config-ikev2-proposal': return this.configIkev2ProposalTrie;
      case 'config-ikev2-policy': return this.configIkev2PolicyTrie;
      case 'config-ikev2-keyring': return this.configIkev2KeyringTrie;
      case 'config-ikev2-keyring-peer': return this.configIkev2KeyringPeerTrie;
      case 'config-ikev2-profile': return this.configIkev2ProfileTrie;
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
    this.privilegedTrie.registerGreedy('ping', 'Send echo messages', (args) => {
      return this._handlePing(args);
    });
    this.privilegedTrie.registerGreedy('traceroute', 'Trace route to destination', (args) => {
      return this._handleTraceroute(args);
    });

    // ── Config mode ──
    buildConfigCommands(this.configTrie, this);
    buildConfigIfCommands(this.configIfTrie, this);
    buildHsrpInterfaceCommands(this.configIfTrie, this, this.fhrp);
    buildVrrpGlbpInterfaceCommands(this.configIfTrie, this, this.fhrp);
    buildBfdInterfaceCommands(this.configIfTrie, {
      selectedPorts: () => this.selectedPortsForConfigIf(),
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
    buildTransformSetCommands(this.configTfsetTrie, this);
    buildCryptoMapEntryCommands(this.configCryptoMapTrie, this);
    buildIPSecProfileCommands(this.configIpsecProfileTrie, this);
    buildIKEv2GlobalCommands(this.configTrie, this);
    buildIKEv2ProposalCommands(this.configIkev2ProposalTrie, this);
    buildIKEv2PolicyCommands(this.configIkev2PolicyTrie, this);
    buildIKEv2KeyringCommands(this.configIkev2KeyringTrie, this);
    buildIKEv2KeyringPeerCommands(this.configIkev2KeyringPeerTrie, this);
    buildIKEv2ProfileCommands(this.configIkev2ProfileTrie, this);
  }

  // ─── Show Commands (Router-specific) ──────────────────────────────

  private registerShowCommands(trie: CommandTrie): void {
    const getRouter = () => this.d();
    registerRoutingProtoShow(trie, this, this.routingCfg);
    registerHsrpShowCommands(trie, this, this.fhrp);
    registerVrrpGlbpShowCommands(trie, this, this.fhrp);
    registerBfdShowCommands(trie, { r: () => this.d() });
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
        section('show version', Show.showVersion(r)),
        section('show running-config', Show.showRunningConfig(r)),
        section('show ip interface brief', Show.showIpIntBrief(r)),
        section('show ip route', Show.showIpRoute(r)),
        section('show interfaces', Show.showInterfacesAll(r)),
        section('show ip protocols', Show.showIpProtocols(r)),
        section('show logging', this.logging.render()),
      ].join('\n\n');
    });

    trie.register('show ip route', 'Display IP routing table', () => Show.showIpRoute(getRouter()));
    trie.register('show ip interface brief', 'Display interface status summary', () => Show.showIpIntBrief(getRouter()));
    trie.register('show running-config', 'Display running configuration', () => Show.showRunningConfig(getRouter()));
    trie.register('show startup-config', 'Display saved configuration', () =>
      this.startupConfig ?? '% startup-config is not present');
    trie.register('show configuration', 'Display saved configuration', () =>
      this.startupConfig ?? '% startup-config is not present');
    trie.register('show ip rip database', 'Display RIP database', () => Show.showIpRipDatabase(getRouter()));
    trie.registerGreedy('show ip cef', 'Display CEF FIB', () => Show.showIpCef(getRouter()));
    // BGP/EIGRP/RIP-extras + show ip protocols come from the
    // RoutingConfigRepository (registerRoutingProtoShow), so they
    // project the real configured process state.
    trie.register('show counters', 'Display traffic counters', () => Show.showCounters(getRouter()));
    trie.register('show ip traffic', 'Display IP traffic statistics', () => Show.showCounters(getRouter()));
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

    trie.register('show version', 'Display system hardware and software status', () => Show.showVersion(getRouter()));

    // `show interface[s] [<name>|description|status|summary]`.
    // Registered under both the singular and plural IOS spellings;
    // dispatch logic lives in one place (single source of truth).
    const showInterfaceCmd = (args: string[]): string => {
      const sub = (args[0] || '').toLowerCase();
      if (args.length === 0) return Show.showInterfacesAll(getRouter());
      if (sub === 'description') return Show.showInterfacesDescription(getRouter());
      if (sub === 'status') return Show.showInterfacesStatus(getRouter());
      if (sub === 'summary') return Show.showInterfacesSummary(getRouter());
      const ifName = resolveInterfaceName(getRouter(), args.join(' '));
      if (!ifName) return `% Invalid input detected at '^' marker.\nshow interface ${args.join(' ')}\n     ^`;
      return Show.showInterface(getRouter(), ifName);
    };
    trie.registerGreedy('show interface', 'Display interface status', showInterfaceCmd);
    trie.registerGreedy('show interfaces', 'Display interface status', showInterfaceCmd);

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
    trie.registerGreedy('show ip interfaces', 'Display IP interface status', showIpInterfaceCmd);
  }

  // ─── Ping Command ────────────────────────────────────────────────

  private _handlePing(args: string[]): string {
    if (args.length === 0) {
      return '% Ping requires a target IP address.';
    }

    let target = '';
    let count = 5;
    let timeoutMs = 2000;
    let sourceIP: string | null = null;

    let i = 0;
    target = args[i++]?.trim() || '';

    while (i < args.length) {
      const kw = args[i]?.toLowerCase();
      if (kw === 'source' && args[i + 1]) {
        sourceIP = args[i + 1];
        i += 2;
      } else if (kw === 'repeat' && args[i + 1]) {
        const n = parseInt(args[i + 1], 10);
        if (!isNaN(n) && n > 0) count = n;
        i += 2;
      } else if (kw === 'timeout' && args[i + 1]) {
        const n = parseInt(args[i + 1], 10);
        if (!isNaN(n) && n > 0) timeoutMs = n * 1000;
        i += 2;
      } else if (kw === 'size' && args[i + 1]) {
        i += 2;
      } else {
        i++;
      }
    }

    if (!target) {
      return '% Ping requires a target IP address.';
    }

    const ipMatch = target.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipMatch) {
      return `% Unrecognized host or address, or protocol not running.`;
    }
    const octets = [+ipMatch[1], +ipMatch[2], +ipMatch[3], +ipMatch[4]];
    if (octets.some(o => o > 255)) {
      return `% Unrecognized host or address, or protocol not running.`;
    }

    if (sourceIP) {
      const router = this.d();
      const resolved = this._resolveSourceIP(router, sourceIP);
      if (resolved) sourceIP = resolved;
    }

    const targetIP = new IPAddress(target);
    const router = this.d();

    this._pendingAsync = router.executePingSequence(targetIP, count, timeoutMs, sourceIP ?? undefined).then(results => {
      return this._formatCiscoPing(target, count, timeoutMs, results);
    });

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

  private _formatCiscoPing(
    target: string,
    count: number,
    timeoutMs: number,
    results: Array<{ success: boolean; rttMs: number; ttl: number; seq: number; fromIP: string; error?: string }>,
  ): string {
    const lines: string[] = [];
    lines.push(`Type escape sequence to abort.`);
    lines.push(`Sending ${count}, 100-byte ICMP Echos to ${target}, timeout is ${timeoutMs / 1000} seconds:`);

    const chars = results.map(r => r.success ? '!' : '.');
    if (results.length === 0) {
      for (let i = 0; i < count; i++) chars.push('.');
    }
    lines.push(chars.join(''));

    const successes = results.filter(r => r.success).length;
    const total = results.length || count;
    const pct = Math.round((successes / total) * 100);
    lines.push(`Success rate is ${pct} percent (${successes}/${total})`);

    if (successes > 0) {
      const rtts = results.filter(r => r.success).map(r => r.rttMs);
      const min = Math.min(...rtts);
      const max = Math.max(...rtts);
      const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
      lines[lines.length - 1] += `, round-trip min/avg/max = ${min.toFixed(0)}/${avg.toFixed(0)}/${max.toFixed(0)} ms`;
    }

    return lines.join('\n');
  }
}
