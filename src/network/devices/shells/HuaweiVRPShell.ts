/**
 * HuaweiVRPShell - Huawei VRP CLI emulation for Router Management Plane
 *
 * FSM-based CLI with CommandTrie for abbreviation/help support:
 *   - User view: <hostname> — display commands, system-view
 *   - System view: [hostname] — configuration commands
 *   - Interface view: [hostname-GE0/0/X] — interface configuration
 *   - DHCP pool view: [hostname-ip-pool-name] — DHCP pool configuration
 *
 * Features:
 *   - Abbreviation matching (e.g. "dis ip ro" → "display ip routing-table")
 *   - Context-aware ? help listing valid completions
 *   - Tab completion
 *
 * Command implementations are extracted into:
 *   - huawei/HuaweiDisplayCommands.ts  — display implementations
 *   - huawei/HuaweiConfigCommands.ts   — config/interface commands
 *   - huawei/HuaweiDhcpCommands.ts     — DHCP commands
 */

import type { Router } from '../Router';
import type { IRouterShell } from './IRouterShell';
import { LoggingConfig } from '../inspection/config/LoggingConfig';
import { CommandTrie } from './CommandTrie';
import { runSshClient } from '../linux/network/LinuxSshClient';
import { HUAWEI_ERRORS, parsePipeFilter, applyPipeFilter, resolveHuaweiNav } from './cli-utils';
import { registerHuaweiCommonMgmt } from './huawei/HuaweiCommonConfig';
import { NetworkOsAccount, type AccountServiceType, type PasswordHashAlgorithm } from '../router/aaa/NetworkOsAccount';
import {
  registerHuaweiCommonSecurity, registerHuaweiCommonSecurityDisplay,
} from './huawei/HuaweiCommonSecurity';
import { IPAddress } from '../../core/types';

// Extracted command modules
import {
  type HuaweiDisplayState,
  registerDisplayCommands, displayCurrentConfig,
} from './huawei/HuaweiDisplayCommands';
import {
  type HuaweiShellMode, type HuaweiShellContext,
  buildSystemCommands, buildInterfaceCommands,
  cmdIpRouteStatic, cmdRip, cmdUndo,
} from './huawei/HuaweiConfigCommands';
import {
  registerDhcpSystemCommands, buildDhcpPoolCommands,
  registerDhcpDisplayCommands, registerDhcpDebugCommands,
} from './huawei/HuaweiDhcpCommands';
import {
  registerOSPFSystemCommands, buildOSPFViewCommands, buildOSPFAreaViewCommands,
  buildOSPFv3ViewCommands, registerOSPFInterfaceCommands,
  registerOSPFDisplayCommands,
} from './huawei/HuaweiOspfCommands';
import {
  type HuaweiIPSecContext,
  registerHuaweiIPSecSystemCommands, registerHuaweiIPSecInterfaceCommands,
  registerHuaweiIPSecDisplayCommands,
  buildHuaweiIKEProposalCommands, buildHuaweiIKEPeerCommands,
  buildHuaweiIPSecProposalCommands, buildHuaweiIPSecPolicyCommands,
  buildHuaweiIKEv2ProposalCommands, buildHuaweiIKEv2PolicyCommands,
  buildHuaweiIKEv2KeyringCommands, buildHuaweiIKEv2KeyringPeerCommands,
  buildHuaweiIKEv2ProfileCommands,
} from './huawei/HuaweiIPSecCommands';
import {
  type HuaweiACLContext, type HuaweiACLMode,
  registerHuaweiACLSystemCommands, registerHuaweiACLInterfaceCommands,
  registerHuaweiACLDisplayCommands,
  buildHuaweiBasicACLCommands, buildHuaweiAdvancedACLCommands,
  runningConfigACL, runningConfigInterfaceACL,
} from './huawei/HuaweiAclCommands';
import {
  registerHuaweiNATInterfaceCommands,
  registerHuaweiNATDisplayCommands,
} from './huawei/HuaweiNATCommands';
import {
  type HuaweiPolicyShellCtx,
  registerHuaweiPolicySystemCommands, registerHuaweiPolicyDisplayCommands,
  buildRoutePolicyView, buildTrafficClassifierView, buildTrafficBehaviorView,
  buildTrafficPolicyView, buildNqaTestView,
} from './huawei/HuaweiPolicyCommands';

export class HuaweiVRPShell implements IRouterShell, HuaweiShellContext, HuaweiDisplayState, HuaweiIPSecContext, HuaweiACLContext, HuaweiPolicyShellCtx {
  readonly logging = new LoggingConfig();
  attachLoggingToBus(bus: import('@/events/EventBus').IEventBus, deviceId: string): void {
    this.logging.attachToBus(bus, deviceId);
  }
  private mode: HuaweiShellMode | string = 'user';
  private readonly cmdHistory: string[] = [];
  private historyMax: number = 10;

  getCmdHistory(): readonly string[] { return [...this.cmdHistory]; }
  setHistoryMax(n: number): void { if (n > 0) this.historyMax = n; this.trimHistory(); }
  private recordHistory(line: string): void {
    if (!line || line.startsWith('?')) return;
    this.cmdHistory.push(line);
    this.trimHistory();
  }
  private trimHistory(): void {
    while (this.cmdHistory.length > this.historyMax) this.cmdHistory.shift();
  }

  private selectedInterface: string | null = null;
  private selectedPool: string | null = null;
  private dhcpEnabled: boolean = false;
  private dhcpSnoopingEnabled: boolean = false;
  /** Track which interfaces have 'dhcp select global' */
  private dhcpSelectGlobalSet: Set<string> = new Set();
  /** OSPF area currently being configured */
  private ospfArea: string | null = null;

  // ── IPSec sub-mode selections ──────────────────────────────────
  private selectedIKEProposal: number | null = null;
  private selectedIKEPeer: string | null = null;
  private selectedIPSecProposal: string | null = null;
  private selectedIPSecPolicy: string | null = null;
  private selectedIPSecPolicySeq: number | null = null;

  // ── ACL sub-mode selections ────────────────────────────────────
  private selectedACLNumber: number | null = null;
  private selectedACLMode: HuaweiACLMode | null = null;
  private selectedACLName: string | null = null;

  private selectedPrefixList: string | null = null;
  private selectedRoutePolicy: string | null = null;
  private selectedRoutePolicyNode: number | null = null;
  private selectedClassifier: string | null = null;
  private selectedBehavior: string | null = null;
  private selectedTrafficPolicy: string | null = null;
  private selectedNqa: { admin: string; name: string } | null = null;

  private routePolicyTrie = new CommandTrie();
  private trafficClassifierTrie = new CommandTrie();
  private trafficBehaviorTrie = new CommandTrie();
  private trafficPolicyTrie = new CommandTrie();
  private nqaTestTrie = new CommandTrie();

  setSelectedPrefixList(n: string | null): void { this.selectedPrefixList = n; }
  getSelectedPrefixList(): string | null { return this.selectedPrefixList; }
  setSelectedRoutePolicy(n: string | null): void { this.selectedRoutePolicy = n; }
  getSelectedRoutePolicy(): string | null { return this.selectedRoutePolicy; }
  setSelectedRoutePolicyNode(n: number | null): void { this.selectedRoutePolicyNode = n; }
  getSelectedRoutePolicyNode(): number | null { return this.selectedRoutePolicyNode; }
  setSelectedClassifier(n: string | null): void { this.selectedClassifier = n; }
  getSelectedClassifier(): string | null { return this.selectedClassifier; }
  setSelectedBehavior(n: string | null): void { this.selectedBehavior = n; }
  getSelectedBehavior(): string | null { return this.selectedBehavior; }
  setSelectedTrafficPolicy(n: string | null): void { this.selectedTrafficPolicy = n; }
  getSelectedTrafficPolicy(): string | null { return this.selectedTrafficPolicy; }
  setSelectedNqa(admin: string | null, name: string | null): void {
    this.selectedNqa = admin && name ? { admin, name } : null;
  }
  getSelectedNqa(): { admin: string; name: string } | null { return this.selectedNqa; }

  /** Temporary reference set during execute() */
  private routerRef: Router | null = null;
  /** Pending async operation (e.g. tracert) — set by a command handler, consumed by execute() */
  private _pendingAsync: Promise<string> | null = null;

  /**
   * Per-vty pager / display preferences (Huawei VRP exec preferences,
   * per-session — see terminal_gap.md §5.3). 24 lines × 80 columns are
   * the VRP defaults; `screen-length 0` (or `screen-length disable`)
   * turns the pager off.
   */
  private screenLength: number = 24;
  private screenWidth: number = 80;

  // Per-mode command tries
  private userTrie = new CommandTrie();
  private systemTrie = new CommandTrie();
  private interfaceTrie = new CommandTrie();
  private dhcpPoolTrie = new CommandTrie();
  private ospfTrie = new CommandTrie();
  private ospfAreaTrie = new CommandTrie();
  // IPSec sub-mode tries
  private ikeProposalTrie = new CommandTrie();
  private ikePeerTrie = new CommandTrie();
  private ipsecProposalTrie = new CommandTrie();
  private ipsecPolicyTrie = new CommandTrie();
  // OSPFv3 sub-mode trie
  private ospfv3Trie = new CommandTrie();
  // user-interface vty sub-mode trie ([host-ui-vty<n>])
  private uiTrie = new CommandTrie();
  private uiLabel: string = '0';
  private selectedUiRange: { first: number; last: number } | null = null;
  // ACL sub-mode tries
  private aclBasicTrie = new CommandTrie();
  private aclAdvancedTrie = new CommandTrie();
  // IKEv2 sub-mode tries
  private ikev2ProposalTrie = new CommandTrie();
  private ikev2PolicyTrie = new CommandTrie();
  private ikev2KeyringTrie = new CommandTrie();
  private ikev2KeyringPeerTrie = new CommandTrie();
  private ikev2ProfileTrie = new CommandTrie();
  // RIP view trie
  private ripTrie = new CommandTrie();

  constructor() {
    this.buildUserCommands();
    this.buildSystemViewCommands();
    this.buildInterfaceViewCommands();
    this.buildDhcpPoolViewCommands();
    this.buildOSPFViewCommands();
    this.buildOSPFAreaViewCommands();
    this.buildOSPFv3ViewCommands();
    this.buildIPSecSubViewCommands();
    this.buildIKEv2SubViewCommands();
    this.buildACLSubViewCommands();
    this.buildUserInterfaceCommands();
    this.buildRIPViewCommands();
    buildRoutePolicyView(this.routePolicyTrie, this);
    buildTrafficClassifierView(this.trafficClassifierTrie, this);
    buildTrafficBehaviorView(this.trafficBehaviorTrie, this);
    buildTrafficPolicyView(this.trafficPolicyTrie, this);
    buildNqaTestView(this.nqaTestTrie, this);
    for (const t of [
      this.userTrie, this.systemTrie, this.interfaceTrie, this.dhcpPoolTrie,
      this.ospfTrie, this.ospfAreaTrie, this.ospfv3Trie, this.ripTrie,
      this.ikeProposalTrie, this.ikePeerTrie, this.ipsecProposalTrie, this.ipsecPolicyTrie,
      this.uiTrie, this.aclBasicTrie, this.aclAdvancedTrie,
      this.ikev2ProposalTrie, this.ikev2PolicyTrie, this.ikev2KeyringTrie,
      this.ikev2KeyringPeerTrie, this.ikev2ProfileTrie,
      this.routePolicyTrie, this.trafficClassifierTrie, this.trafficBehaviorTrie,
      this.trafficPolicyTrie, this.nqaTestTrie,
    ]) {
      this.registerDisplayThis(t);
    }
  }

  getOSType(): string { return 'huawei-vrp'; }

  // ─── HuaweiShellContext Implementation ──────────────────────────────

  r(): Router {
    if (!this.routerRef) throw new Error('Router reference not set (BUG)');
    return this.routerRef;
  }

  setMode(mode: HuaweiShellMode): void { this.mode = mode; }
  getMode(): string { return this.mode; }

  getSelectedInterface(): string | null { return this.selectedInterface; }
  setSelectedInterface(iface: string | null): void { this.selectedInterface = iface; }

  getSelectedPool(): string | null { return this.selectedPool; }
  setSelectedPool(pool: string | null): void { this.selectedPool = pool; }

  getDhcpSelectGlobal(): Set<string> { return this.dhcpSelectGlobalSet; }

  // ─── HuaweiIPSecContext Implementation ──────────────────────────────

  // ─── Per-vty state snapshot / swap (§5.1 of terminal_gap.md) ─────

  /**
   * Capture every mode-related field into a snapshot. Mirrors
   * CiscoIOSShell.snapshotVtyState. Router.executeCommandInVty uses
   * this to swap per-terminal state in for the duration of a command.
   */
  snapshotVtyState(): import('./vty/CliShellSession').VtySnapshot {
    return {
      mode: this.mode,
      selectedInterface: this.selectedInterface,
      selectedRoutingProto: null,                  // VRP: not modelled here
      selectedTrack: null,
      selectedIpSla: null,
      selectedRouteMap: null,
      selectedDHCPPool: this.selectedPool,
      selectedACL: this.selectedACLName,
      selectedACLType: null,
      selectedISAKMPPriority: this.selectedIKEProposal,
      selectedTransformSet: this.selectedIPSecProposal,
      selectedCryptoMap: this.selectedIPSecPolicy,
      selectedCryptoMapSeq: this.selectedIPSecPolicySeq,
      selectedCryptoMapIsDynamic: false,
      selectedIPSecProfile: null,
      selectedIKEv2Proposal: null,
      selectedIKEv2Policy: null,
      selectedIKEv2Keyring: null,
      selectedIKEv2KeyringPeer: null,
      selectedIKEv2Profile: null,
      terminalLength: this.screenLength,
      terminalWidth: this.screenWidth,
      privilegeLevel: this.mode === 'user' || this.mode === 'user-view' ? 1 : 15,
      historySize: this.historyMax,
      cmdHistory: [...this.cmdHistory],
    };
  }

  /** Apply a session's snapshot onto this shell instance. */
  applyVtyState(s: import('./vty/CliShellSession').VtySnapshot): void {
    this.mode = (s.mode ?? 'user') as HuaweiShellMode;
    this.selectedInterface = s.selectedInterface;
    this.selectedPool = s.selectedDHCPPool;
    this.selectedACLName = s.selectedACL;
    this.selectedIKEProposal = s.selectedISAKMPPriority;
    this.selectedIPSecProposal = s.selectedTransformSet;
    this.selectedIPSecPolicy = s.selectedCryptoMap;
    this.selectedIPSecPolicySeq = s.selectedCryptoMapSeq;
    this.screenLength = s.terminalLength;
    this.screenWidth = s.terminalWidth;
  }

  setSelectedIKEProposal(n: number | null): void { this.selectedIKEProposal = n; }
  getSelectedIKEProposal(): number | null { return this.selectedIKEProposal; }
  setSelectedIKEPeer(name: string | null): void { this.selectedIKEPeer = name; }
  getSelectedIKEPeer(): string | null { return this.selectedIKEPeer; }
  setSelectedIPSecProposal(name: string | null): void { this.selectedIPSecProposal = name; }
  getSelectedIPSecProposal(): string | null { return this.selectedIPSecProposal; }
  setSelectedIPSecPolicy(name: string | null): void { this.selectedIPSecPolicy = name; }
  getSelectedIPSecPolicy(): string | null { return this.selectedIPSecPolicy; }
  setSelectedIPSecPolicySeq(seq: number | null): void { this.selectedIPSecPolicySeq = seq; }
  getSelectedIPSecPolicySeq(): number | null { return this.selectedIPSecPolicySeq; }

  // ─── HuaweiACLContext Implementation ────────────────────────────────

  getSelectedACLNumber(): number | null { return this.selectedACLNumber; }
  setSelectedACLNumber(n: number | null): void { this.selectedACLNumber = n; }
  getSelectedACLMode(): HuaweiACLMode | null { return this.selectedACLMode; }
  setSelectedACLMode(m: HuaweiACLMode | null): void { this.selectedACLMode = m; }
  getSelectedACLName(): string | null { return this.selectedACLName; }
  setSelectedACLName(n: string | null): void { this.selectedACLName = n; }

  // ─── HuaweiDisplayState Implementation ─────────────────────────────

  isDhcpEnabled(): boolean { return this.dhcpEnabled; }
  isDhcpSnoopingEnabled(): boolean { return this.dhcpSnoopingEnabled; }
  renderLogbuffer(): string { return this.logging.renderHuawei(); }

  // ─── Prompt Generation ─────────────────────────────────────────────

  getPrompt(router: Router): string {
    const host = router._getHostnameInternal();
    switch (this.mode) {
      case 'user':       return `<${host}>`;
      case 'system':     return `[${host}]`;
      case 'interface':  return `[${host}-${this.selectedInterface}]`;
      case 'dhcp-pool':  return `[${host}-ip-pool-${this.selectedPool}]`;
      case 'ospf':       return `[${host}-ospf-1]`;
      case 'ospf-area':  return `[${host}-ospf-1-area-${this.ospfArea}]`;
      case 'ospfv3':     return `[${host}-ospfv3-1]`;
      case 'rip':        return `[${host}-rip-1]`;
      case 'ui':         return `[${host}-ui-vty${this.uiLabel}]`;
      case 'ike-proposal':  return `[${host}-ike-proposal-${this.selectedIKEProposal}]`;
      case 'ike-peer':      return `[${host}-ike-peer-${this.selectedIKEPeer}]`;
      case 'ipsec-proposal': return `[${host}-ipsec-proposal-${this.selectedIPSecProposal}]`;
      case 'ipsec-policy':  return `[${host}-ipsec-policy-${this.selectedIPSecPolicy}-${this.selectedIPSecPolicySeq}]`;
      case 'acl-basic':    return `[${host}-acl-basic-${this.selectedACLName || this.selectedACLNumber}]`;
      case 'acl-advanced': return `[${host}-acl-adv-${this.selectedACLName || this.selectedACLNumber}]`;
      case 'ikev2-proposal': return `[${host}-ikev2-proposal-${this.selectedIPSecProposal}]`;
      case 'ikev2-policy':   return `[${host}-ikev2-policy-${this.selectedIPSecPolicy}]`;
      case 'ikev2-keyring':  return `[${host}-ikev2-keyring-${this.selectedIKEPeer}]`;
      case 'ikev2-keyring-peer': return `[${host}-ikev2-keyring-peer-${this.selectedIPSecProposal}]`;
      case 'ikev2-profile':  return `[${host}-ikev2-profile-${this.selectedIPSecProposal}]`;
      case 'route-policy': return `[${host}-route-policy-${this.selectedRoutePolicy}-${this.selectedRoutePolicyNode}]`;
      case 'traffic-classifier': return `[${host}-classifier-${this.selectedClassifier}]`;
      case 'traffic-behavior': return `[${host}-behavior-${this.selectedBehavior}]`;
      case 'traffic-policy': return `[${host}-trafficpolicy-${this.selectedTrafficPolicy}]`;
      case 'nqa-test': return `[${host}-nqa-${this.selectedNqa?.admin}-${this.selectedNqa?.name}]`;
      default:           return `<${host}>`;
    }
  }

  // ─── Main Execute ──────────────────────────────────────────────────

  execute(router: Router, rawInput: string): string {
    const trimmed = rawInput.trim();
    if (!trimmed) return '';

    if (trimmed.endsWith('?')) {
      const helpInput = trimmed.slice(0, -1);
      return this.getHelp(helpInput);
    }

    this.recordHistory(trimmed);

    // Split off an output pipe filter (| include/exclude/begin …) — shared
    // with the switch shell + Cisco shells via cli-utils (DRY).
    const { cmd, filter } = parsePipeFilter(trimmed);
    const lower = cmd.toLowerCase();

    // Global navigation — accepts unambiguous VRP abbreviations.
    const nav = resolveHuaweiNav(lower);
    if (nav === 'return') {
      this.mode = 'user';
      this.selectedInterface = null;
      this.selectedPool = null;
      this.selectedIKEProposal = null;
      this.selectedIKEPeer = null;
      this.selectedIPSecProposal = null;
      this.selectedIPSecPolicy = null;
      this.selectedIPSecPolicySeq = null;
      this.selectedACLNumber = null;
      this.selectedACLMode = null;
      this.selectedACLName = null;
      this.selectedRoutePolicy = null;
      this.selectedRoutePolicyNode = null;
      this.selectedClassifier = null;
      this.selectedBehavior = null;
      this.selectedTrafficPolicy = null;
      this.selectedNqa = null;
      return '';
    }
    if (nav === 'quit') return this.cmdQuit();

    // Bind router reference
    this.routerRef = router;

    // Expand `command-alias` shortcuts before any trie match — same
    // behaviour as the SSH dispatcher so the local shell honours
    // installed aliases.
    const aliasTable = router._getCommandAliases?.();
    const effective = aliasTable ? aliasTable.expand(cmd) : cmd;
    const output = this.executeOnTrie(effective);

    // Async escape hatch (e.g. tracert sets _pendingAsync)
    if (this._pendingAsync) {
      const asyncOp = this._pendingAsync;
      this._pendingAsync = null;
      this.routerRef = null;
      return asyncOp;
    }

    this.routerRef = null;
    return filter && !output.startsWith('Error:')
      ? applyPipeFilter(output, filter)
      : output;
  }

  private executeOnTrie(cmdPart: string): string {
    const trie = this.getActiveTrie();
    const result = trie.match(cmdPart);

    switch (result.status) {
      case 'ok':
        if (result.node?.action) {
          return result.node.action(result.args, cmdPart);
        }
        return '';

      case 'ambiguous':
        return result.error || HUAWEI_ERRORS.AMBIGUOUS(cmdPart);

      case 'incomplete':
        return result.error || HUAWEI_ERRORS.INCOMPLETE;

      case 'invalid':
        return result.error || HUAWEI_ERRORS.UNRECOGNIZED(cmdPart);

      default:
        return HUAWEI_ERRORS.UNRECOGNIZED(cmdPart);
    }
  }

  /**
   * Parse `stelnet [user@]host [port]` / `ssh [-l user] [-p port] host
   * [cmd]` and dispatch through the shared runSshClient. Source IP is
   * picked from the first up interface that has one.
   */
  private runOutboundSshClient(args: string[]): string {
    let user = 'admin';
    let port: string | null = null;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-l' && args[i + 1]) { user = args[++i]; continue; }
      if (a === '-p' && args[i + 1]) { port = args[++i]; continue; }
      if (a.startsWith('-')) continue;
      rest.push(a);
    }
    if (rest.length === 0) return 'Error: Incomplete command.';
    let host = rest[0];
    const at = host.indexOf('@');
    if (at !== -1) { user = host.slice(0, at); host = host.slice(at + 1); }
    if (!port && rest[1] && /^\d+$/.test(rest[1])) port = rest[1];
    const cmd = rest.slice(port ? 2 : 1).join(' ');
    const router = this.routerRef as unknown as {
      _getPortsInternal: () => Map<string, { getIPAddress: () => { toString: () => string } | null; getIsUp: () => boolean }>;
      _getHostnameInternal: () => string;
      _getHostsTable?: () => { resolve: (n: string) => string | null };
    };
    if (!router) return 'Error: device not bound';
    const resolved = router._getHostsTable?.().resolve(host);
    if (resolved) host = resolved;
    let sourceIp: string | null = null;
    for (const [, p] of router._getPortsInternal()) {
      const ip = p.getIPAddress();
      if (ip && p.getIsUp()) { sourceIp = ip.toString(); break; }
    }
    if (!sourceIp) return 'Error: no usable interface IP for outbound SSH';
    const clientArgs: string[] = [];
    if (port) clientArgs.push('-p', port);
    clientArgs.push('-o', 'StrictHostKeyChecking=accept-new');
    clientArgs.push(`${user}@${host}`);
    if (cmd) clientArgs.push(cmd);
    const result = runSshClient({
      args: clientArgs,
      sourceHostname: router._getHostnameInternal(),
      sourceIp, sourceUser: user,
      localVfs: { readFile: () => null, writeFile: () => undefined },
    });
    return result.output;
  }

  private cmdQuit(): string {
    switch (this.mode) {
      case 'interface':
        this.mode = 'system';
        this.selectedInterface = null;
        return '';
      case 'dhcp-pool':
        this.mode = 'system';
        this.selectedPool = null;
        return '';
      case 'ospf-area':
        this.mode = 'ospf';
        this.ospfArea = null;
        return '';
      case 'ospf':
        this.mode = 'system';
        return '';
      case 'ospfv3':
        this.mode = 'system';
        return '';
      case 'rip':
        this.mode = 'system';
        return '';
      case 'ui':
        this.mode = 'system';
        return '';
      case 'ike-proposal':
        this.mode = 'system';
        this.selectedIKEProposal = null;
        return '';
      case 'ike-peer':
        this.mode = 'system';
        this.selectedIKEPeer = null;
        return '';
      case 'ipsec-proposal':
        this.mode = 'system';
        this.selectedIPSecProposal = null;
        return '';
      case 'ipsec-policy':
        this.mode = 'system';
        this.selectedIPSecPolicy = null;
        this.selectedIPSecPolicySeq = null;
        return '';
      case 'acl-basic':
      case 'acl-advanced':
        this.mode = 'system';
        this.selectedACLNumber = null;
        this.selectedACLMode = null;
        this.selectedACLName = null;
        return '';
      case 'ikev2-proposal':
      case 'ikev2-policy':
      case 'ikev2-profile':
        this.mode = 'system';
        this.selectedIPSecProposal = null;
        this.selectedIPSecPolicy = null;
        return '';
      case 'ikev2-keyring':
        this.mode = 'system';
        this.selectedIKEPeer = null;
        return '';
      case 'ikev2-keyring-peer':
        this.mode = 'ikev2-keyring';
        this.selectedIPSecProposal = null;
        return '';
      case 'route-policy':
        this.mode = 'system';
        this.selectedRoutePolicy = null;
        this.selectedRoutePolicyNode = null;
        return '';
      case 'traffic-classifier':
        this.mode = 'system';
        this.selectedClassifier = null;
        return '';
      case 'traffic-behavior':
        this.mode = 'system';
        this.selectedBehavior = null;
        return '';
      case 'traffic-policy':
        this.mode = 'system';
        this.selectedTrafficPolicy = null;
        return '';
      case 'nqa-test':
        this.mode = 'system';
        this.selectedNqa = null;
        return '';
      case 'system':
        this.mode = 'user';
        return '';
      case 'user':
        return '';
      default:
        return '';
    }
  }

  // ─── Help / Completion ─────────────────────────────────────────────

  getHelp(input: string): string {
    const trie = this.getActiveTrie();
    const completions = trie.getCompletions(input);
    if (completions.length === 0) return 'Error: Unrecognized command';
    const maxKw = Math.max(...completions.map(c => c.keyword.length));
    return completions
      .map(c => `  ${c.keyword.padEnd(maxKw + 2)}${c.description}`)
      .join('\n');
  }

  tabComplete(input: string): string | null {
    const trie = this.getActiveTrie();
    return trie.tabComplete(input);
  }

  // ─── Active Trie Selection ─────────────────────────────────────────

  private getActiveTrie(): CommandTrie {
    switch (this.mode) {
      case 'user': return this.userTrie;
      case 'system': return this.systemTrie;
      case 'interface': return this.interfaceTrie;
      case 'dhcp-pool': return this.dhcpPoolTrie;
      case 'ospf': return this.ospfTrie;
      case 'ospf-area': return this.ospfAreaTrie;
      case 'ospfv3': return this.ospfv3Trie;
      case 'rip': return this.ripTrie;
      case 'ike-proposal': return this.ikeProposalTrie;
      case 'ike-peer': return this.ikePeerTrie;
      case 'ipsec-proposal': return this.ipsecProposalTrie;
      case 'ipsec-policy': return this.ipsecPolicyTrie;
      case 'ui': return this.uiTrie;
      case 'acl-basic': return this.aclBasicTrie;
      case 'acl-advanced': return this.aclAdvancedTrie;
      case 'ikev2-proposal': return this.ikev2ProposalTrie;
      case 'ikev2-policy': return this.ikev2PolicyTrie;
      case 'ikev2-keyring': return this.ikev2KeyringTrie;
      case 'ikev2-keyring-peer': return this.ikev2KeyringPeerTrie;
      case 'ikev2-profile': return this.ikev2ProfileTrie;
      case 'route-policy': return this.routePolicyTrie;
      case 'traffic-classifier': return this.trafficClassifierTrie;
      case 'traffic-behavior': return this.trafficBehaviorTrie;
      case 'traffic-policy': return this.trafficPolicyTrie;
      case 'nqa-test': return this.nqaTestTrie;
      default: return this.userTrie;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Command Registration (per-mode CommandTrie construction)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Overwrite the `screen-length` / `screen-width` greedy stubs from
   * `registerHuaweiCommonMgmt` with handlers that actually mutate the
   * shell's per-vty preferences. Called from each per-mode trie builder
   * after the common-mgmt registration, so the latest action wins.
   *
   * Syntax (VRP):
   *   screen-length <0-512> [temporary]   — set rows (0 = pager off)
   *   screen-length disable               — alias for `screen-length 0`
   *   undo screen-length                  — restore default (24)
   *   screen-width <80-512>               — set columns
   *   undo screen-width                   — restore default (80)
   */
  private registerScreenSizeCommands(t: CommandTrie): void {
    t.registerGreedy('screen-length', 'Set terminal screen length', (args) => {
      if (args.length === 0) return HUAWEI_ERRORS.INCOMPLETE;
      const head = args[0].toLowerCase();
      if (head === 'disable') { this.screenLength = 0; return ''; }
      const n = parseInt(head, 10);
      if (!Number.isFinite(n) || n < 0 || n > 512) {
        return HUAWEI_ERRORS.UNRECOGNIZED(args.join(' '));
      }
      this.screenLength = n;
      return '';
    });
    t.registerGreedy('screen-width', 'Set terminal screen width', (args) => {
      if (args.length === 0) return HUAWEI_ERRORS.INCOMPLETE;
      const n = parseInt(args[0], 10);
      if (!Number.isFinite(n) || n < 80 || n > 512) {
        return HUAWEI_ERRORS.UNRECOGNIZED(args.join(' '));
      }
      this.screenWidth = n;
      return '';
    });
    t.registerGreedy('undo screen-length', 'Restore default screen length', () => {
      this.screenLength = 24; return '';
    });
    t.registerGreedy('undo screen-width', 'Restore default screen width', () => {
      this.screenWidth = 80; return '';
    });
  }

  private renderDisplayThis(): string {
    const router = this.r();
    const config = displayCurrentConfig(router, this.dhcpEnabled, this.dhcpSnoopingEnabled, this.dhcpSelectGlobalSet);
    const lines = config.split('\n');
    const selIface = this.selectedInterface;
    const renderName = (n: string) => n.startsWith('GE') ? n.replace(/^GE/, 'GigabitEthernet') : n;
    switch (this.mode) {
      case 'interface': {
        if (!selIface) return '#';
        const target = `interface ${renderName(selIface)}`;
        const out: string[] = ['#', target];
        let inside = false;
        for (const l of lines) {
          if (l === target) { inside = true; continue; }
          if (inside) {
            if (l.startsWith('#')) break;
            if (l.startsWith('interface ')) break;
            out.push(l);
          }
        }
        out.push('#');
        return out.join('\n');
      }
      case 'ospf':
      case 'ospf-area': {
        const out: string[] = ['#'];
        let inside = false;
        for (const l of lines) {
          if (/^ospf \d/.test(l)) { inside = true; out.push(l); continue; }
          if (inside) {
            if (l.startsWith('#')) break;
            out.push(l);
          }
        }
        out.push('#');
        return out.join('\n');
      }
      case 'rip': {
        const out: string[] = ['#'];
        let inside = false;
        for (const l of lines) {
          if (/^rip \d/.test(l)) { inside = true; out.push(l); continue; }
          if (inside) {
            if (l.startsWith('#')) break;
            out.push(l);
          }
        }
        out.push('#');
        return out.join('\n');
      }
      case 'dhcp-pool': {
        if (!this.selectedPool) return '#';
        const target = `ip pool ${this.selectedPool}`;
        const out: string[] = ['#', target];
        let inside = false;
        for (const l of lines) {
          if (l === target) { inside = true; continue; }
          if (inside) {
            if (l.startsWith('#')) break;
            out.push(l);
          }
        }
        out.push('#');
        return out.join('\n');
      }
      default:
        return config;
    }
  }

  private registerDisplayThis(t: CommandTrie): void {
    t.register('display this', 'Display current view configuration', () => this.renderDisplayThis());
  }

  getScreenLength(): number { return this.screenLength; }
  /** Symmetric with getScreenLength — column hint. */
  getScreenWidth(): number { return this.screenWidth; }

  // ─── User View (<hostname>) ──────────────────────────────────────

  private buildUserInterfaceCommands(): void {
    const t = this.uiTrie;
    // No-op keywords accepted at the user-interface view.
    for (const kw of ['user', 'screen-length', 'history-command', 'shell',
      'set', 'authorization-mode']) {
      t.registerGreedy(kw, `user-interface ${kw}`, (args, raw) => {
        const r = this.selectedUiRange;
        if (!r) return '';
        const lc = this.routerRef?._getVtyLineConfig?.();
        if (!lc) return '';
        const update: Record<string, unknown> = { first: r.first, last: r.last };
        if (kw === 'screen-length' && args[0]) {
          update.screenLength = parseInt(args[0], 10);
        } else if (kw === 'history-command' && args[0] === 'max-size' && args[1]) {
          update.historyCommandMaxSize = parseInt(args[1], 10);
        } else if (kw === 'shell') {
          update.shellEnabled = true;
        } else if (kw === 'authorization-mode' && args[0]) {
          update.authorizationMode = args[0];
        } else if (kw === 'user' && args[0] === 'privilege' && args[1] === 'level' && args[2]) {
          update.privilegeLevel = parseInt(args[2], 10);
        } else {
          update.rawLine = raw ?? `${kw} ${args.join(' ')}`.trim();
        }
        lc.upsert(update as Parameters<typeof lc.upsert>[0]);
        return '';
      });
    }
    t.registerGreedy('idle-timeout', 'Set idle-timeout', (args) => {
      const r = this.selectedUiRange; if (!r) return '';
      this.routerRef?._getVtyLineConfig?.().upsert({
        first: r.first, last: r.last,
        idleTimeoutMinutes: Number.parseInt(args[0] ?? '0', 10),
        idleTimeoutSeconds: Number.parseInt(args[1] ?? '0', 10),
      });
      return '';
    });
    t.registerGreedy('authentication-mode', 'Set authentication mode', (args) => {
      const r = this.selectedUiRange; if (!r) return '';
      const mode = (args[0] ?? '').toLowerCase();
      if (mode === 'aaa' || mode === 'password' || mode === 'none') {
        this.routerRef?._getVtyLineConfig?.().upsert({
          first: r.first, last: r.last, authenticationMode: mode,
        });
      }
      return '';
    });
    t.registerGreedy('acl', 'Apply ACL to VTY', (args) => {
      const r = this.selectedUiRange; if (!r) return '';
      const dir = (args[1] ?? 'inbound').toLowerCase();
      const field = dir === 'outbound' ? 'aclOutbound' : 'aclInbound';
      this.routerRef?._getVtyLineConfig?.().upsert({
        first: r.first, last: r.last, [field]: args[0],
      });
      return '';
    });
    // `protocol inbound {ssh|telnet|all|none}` routes through the device
    // so CrossVendorSshHost sees the change (matches Cisco transport input).
    t.registerGreedy('protocol', 'user-interface protocol inbound', (args) => {
      if (args[0]?.toLowerCase() !== 'inbound' || !args[1]) return '';
      const proto = args[1].toLowerCase() as 'ssh' | 'telnet' | 'all' | 'none';
      if (['ssh', 'telnet', 'all', 'none'].includes(proto)) {
        const dev = this.routerRef as unknown as { _setVtyTransportInput?: (t: 'ssh' | 'telnet' | 'all' | 'none') => void };
        dev?._setVtyTransportInput?.(proto);
        const r = this.selectedUiRange;
        if (r) this.routerRef?._getVtyLineConfig?.().upsert({ first: r.first, last: r.last, transportInput: proto });
      }
      return '';
    });
    // `undo protocol inbound [ssh|telnet]` — removing one transport leaves
    // the other (matches VRP convention); with no arg, both are removed.
    t.registerGreedy('undo', 'user-interface undo', (args) => {
      if (args[0]?.toLowerCase() !== 'protocol' || args[1]?.toLowerCase() !== 'inbound') return '';
      const removed = (args[2] ?? '').toLowerCase();
      const dev = this.routerRef as unknown as { _setVtyTransportInput?: (t: 'ssh' | 'telnet' | 'all' | 'none') => void };
      if (!dev?._setVtyTransportInput) return '';
      if (removed === 'ssh') dev._setVtyTransportInput('telnet');
      else if (removed === 'telnet') dev._setVtyTransportInput('ssh');
      else dev._setVtyTransportInput('none');
      return '';
    });
  }

  private buildUserCommands(): void {
    const t = this.userTrie;
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;

    t.register('system-view', 'Enter system view', () => {
      this.mode = 'system';
      return 'Enter system view, return user view with return command.';
    });

    // `stelnet [user@]host [port]` and `ssh [-l user] host` — outbound
    // SSH client, dispatched through the shared runSshClient so every
    // gate (host key TOFU, sshd policy, VTY ACL) applies uniformly.
    for (const verb of ['stelnet', 'ssh']) {
      t.registerGreedy(verb, `${verb} client`, (args) => this.runOutboundSshClient(args));
    }

    // Display commands
    registerDisplayCommands(t, getRouter, getState);

    // VRP lifecycle/management commands (shared with the switch, DRY)
    registerHuaweiCommonMgmt(t);
    t.registerGreedy('header', 'Configure login/shell banner', (args) => {
      const router = getRouter() as unknown as { _setSshBanner?: (b: string) => void };
      if (typeof router._setSshBanner === 'function') {
        const rest = args.slice(args[0] === 'login' && args[1] === 'information' ? 2 : 1).join(' ');
        router._setSshBanner(rest.replace(/^["']/, '').replace(/["']$/, ''));
      }
      return '';
    });
    this.registerScreenSizeCommands(t);
    registerHuaweiCommonSecurityDisplay(t, () => new Map());

    // OSPF display commands
    registerOSPFDisplayCommands(t, getRouter);

    // IPSec display commands
    registerHuaweiIPSecDisplayCommands(t, getRouter);

    // ACL display commands
    registerHuaweiACLDisplayCommands(t, getRouter);

    // NAT display commands
    registerHuaweiNATDisplayCommands(t, getRouter);

    // Backward-compat aliases in user view
    t.registerGreedy('ip route-static', 'Configure static route', (args) => {
      return cmdIpRouteStatic(getRouter(), args);
    });

    t.registerGreedy('rip', 'Configure RIP routing', (args) => {
      return cmdRip(getRouter(), args);
    });

    t.registerGreedy('undo', 'Undo configuration', (args) => {
      return cmdUndo(getRouter(), this, args);
    });

    // tracert — route tracing (async)
    t.registerGreedy('tracert', 'Trace route to destination', (args) => {
      return this._handleTracert(args);
    });

    // ping — ICMP echo (async)
    t.registerGreedy('ping', 'Send ICMP echo messages', (args) => {
      return this._handlePing(args);
    });

    // reset arp — clear all ARP entries
    t.register('reset arp', 'Clear all ARP entries', () => {
      getRouter()._clearARPCache();
      return '';
    });

    // reset arp dynamic — clear only dynamic ARP entries
    t.register('reset arp dynamic', 'Clear dynamic ARP entries', () => {
      const arpTable = getRouter()._getArpTableInternal();
      for (const [ip, entry] of [...arpTable.entries()]) {
        if ((entry as any).type !== 'static') arpTable.delete(ip);
      }
      return '';
    });

    // reset counters — reset IP traffic counters
    t.register('reset counters', 'Reset traffic counters', () => {
      getRouter().resetCounters();
      return '';
    });

    // save — persist configuration (Huawei equivalent of write memory)
    t.register('save', 'Save current configuration', () => {
      return 'The current configuration will be written to the device.\nInfo: Please input the file name ( *.cfg, *.zip ) [vrpcfg.zip]:vrpcfg.zip\nNow saving the current configuration to the slot.\nSave the configuration successfully.';
    });

    registerDhcpDisplayCommands(t, getRouter);
    registerDhcpDebugCommands(t, getRouter);
    registerHuaweiPolicyDisplayCommands(t, getRouter);
  }

  // ─── System View ([hostname]) ────────────────────────────────────

  private buildSystemViewCommands(): void {
    const t = this.systemTrie;
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;

    // Display commands (available in all modes)
    registerDisplayCommands(t, getRouter, getState);

    // VRP lifecycle/management commands (shared with the switch, DRY)
    registerHuaweiCommonMgmt(t);

    const applyLldp = (fn: (a: import('@/network/lldp/LldpAgent').LldpAgent) => void): void => {
      const ag = (getRouter() as unknown as { getLldpAgent?: () => import('@/network/lldp/LldpAgent').LldpAgent }).getLldpAgent?.();
      if (ag) fn(ag);
    };
    t.register('lldp enable', 'Enable LLDP globally', () => {
      applyLldp(a => a.setEnabled(true));
      return '';
    });
    t.register('undo lldp enable', 'Disable LLDP globally', () => {
      applyLldp(a => a.setEnabled(false));
      return '';
    });
    t.registerGreedy('lldp message-transmission interval', 'Hello period (sec)', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 5 || n > 32768) return 'Error: Wrong parameter found.';
      applyLldp(a => a.setTimerSec(n));
      return '';
    });
    t.registerGreedy('lldp message-transmission hold-multiplier', 'Hold multiplier', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 2 || n > 10) return 'Error: Wrong parameter found.';
      applyLldp(a => a.setHoldtimeMultiplier(n));
      return '';
    });

    t.registerGreedy('header', 'Configure login/shell banner', (args) => {
      const router = getRouter() as unknown as { _setSshBanner?: (b: string) => void };
      if (typeof router._setSshBanner === 'function') {
        const rest = args.slice(args[0] === 'login' && args[1] === 'information' ? 2 : 1).join(' ');
        router._setSshBanner(rest.replace(/^["']/, '').replace(/["']$/, ''));
      }
      return '';
    });
    t.registerGreedy('ssh', 'SSH server configuration', (args) => {
      const router = getRouter() as unknown as {
        _configureSshAuthRetries?: (n: number) => void;
      };
      if (args[0] === 'server' && args[1] === 'authentication-retries' && /^\d+$/.test(args[2] ?? '')) {
        router._configureSshAuthRetries?.(Number(args[2]));
      }
      return '';
    });
    // `command-alias enable|disable` + `command-alias alias <h> <expansion>`
    // mirror the VRP CLI alias feature consumed by runSshCommandSync.
    t.registerGreedy('command-alias', 'CLI alias configuration', (args) => {
      const table = getRouter()._getCommandAliases?.();
      if (!table) return '';
      const first = args[0]?.toLowerCase();
      if (first === 'enable')  { table.enable();  return ''; }
      if (first === 'disable') { table.disable(); return ''; }
      if (first === 'alias' && args[1] && args.length >= 3) {
        table.add(args[1], args.slice(2).join(' '));
        return '';
      }
      return '';
    });
    t.registerGreedy('undo command-alias', 'Disable CLI alias', (args) => {
      const table = getRouter()._getCommandAliases?.();
      if (!table) return '';
      if (args[0]?.toLowerCase() === 'alias' && args[1]) { table.remove(args[1]); return ''; }
      table.disable();
      return '';
    });

    // `ip host <name> <ip>` — VRP static hostname → IP table consulted
    // before any DNS fallback by stelnet / ping / traceroute.
    t.registerGreedy('ip host', 'Configure a static host entry', (args) => {
      if (args.length < 2) return 'Error: Incomplete command.';
      getRouter()._getHostsTable?.().upsert(args[0], args[1]);
      return '';
    });
    t.registerGreedy('undo ip host', 'Remove a static host entry', (args) => {
      if (args.length < 1) return 'Error: Incomplete command.';
      getRouter()._getHostsTable?.().remove(args[0]);
      return '';
    });
    t.registerGreedy('local-user', 'Configure a local user', (args) => {
      const router = getRouter();
      const name = args[0];
      if (!name || args.length < 2) return 'Error: Incomplete command.';
      const store = router.getCredentialStore();
      const existing = store.get(name) ?? NetworkOsAccount.create({ name });
      const kw = args[1].toLowerCase();
      let next = existing;
      if (kw === 'password') {
        const idx = args.indexOf('cipher') >= 0 ? args.indexOf('cipher') : args.indexOf('irreversible-cipher');
        const algo: PasswordHashAlgorithm = idx >= 0
          ? (args[idx] === 'irreversible-cipher' ? 'irreversible-cipher' : 'cipher')
          : 'plain';
        next = existing.withSecret(args[idx >= 0 ? idx + 1 : args.length - 1] ?? existing.secret, algo);
      } else if (kw === 'privilege' && args[2] === 'level' && args[3]) {
        next = existing.withPrivilege(Number(args[3]) || existing.privilege);
      } else if (kw === 'service-type') {
        const types = args.slice(2).filter(t => t.length > 0) as AccountServiceType[];
        next = existing.withServiceTypes(types);
      } else if (kw === 'state') {
        next = args[2] === 'active' ? existing.enable() : args[2] === 'block' ? existing.disable() : existing;
      } else if (kw === 'ftp-directory' && args[2]) {
        next = existing.withFtpDirectory(args[2]);
      } else if (kw === 'idle-timeout' && args[2]) {
        next = existing.withIdleTimeout(Number(args[2]) * 60);
      } else if (kw === 'access-limit' && args[2]) {
        next = existing.withMaxSessions(Number(args[2]));
      }
      store.upsert(next);
      return '';
    });
    this.registerScreenSizeCommands(t);
    registerHuaweiCommonSecurity(t, () => this.r() as unknown as { getManagementService: () => import('../router/management/RouterManagementService').RouterManagementService });
    registerHuaweiCommonSecurityDisplay(t, () => new Map());
    t.registerGreedy('ssh', 'SSH server configuration', (args) => {
      const router = getRouter() as unknown as {
        _configureSshAuthRetries?: (n: number) => void;
      };
      if (args[0] === 'server' && args[1] === 'authentication-retries' && /^\d+$/.test(args[2] ?? '')) {
        router._configureSshAuthRetries?.(Number(args[2]));
      }
      return '';
    });

    // `user-interface vty <first> [last]` — enter VTY user-interface view
    // so subsequent `protocol inbound {ssh|telnet|all|none}` toggles the
    // device's accepted VTY transports.
    t.registerGreedy('user-interface', 'Enter user-interface view', (args) => {
      if (args[0]?.toLowerCase() === 'vty') {
        this.uiLabel = args[1] && args[2] ? `${args[1]} ${args[2]}` : (args[1] ?? '0');
        this.mode = 'ui';
        const first = Number.parseInt(args[1] ?? '0', 10);
        const last  = Number.parseInt(args[2] ?? args[1] ?? '0', 10);
        this.selectedUiRange = { first, last };
        this.routerRef?._getVtyLineConfig?.().upsert({ first, last });
      }
      return '';
    });

    // System-mode config commands
    buildSystemCommands(t, this);

    // DHCP system-mode commands
    registerDhcpSystemCommands(t, this, {
      setDhcpEnabled: (v) => { this.dhcpEnabled = v; },
      setDhcpSnoopingEnabled: (v) => { this.dhcpSnoopingEnabled = v; },
    });

    // OSPF system-mode commands
    registerOSPFSystemCommands(t, this as any, (area) => { this.ospfArea = area; });

    // OSPF display commands
    registerOSPFDisplayCommands(t, () => this.r());

    // IPSec system-mode commands
    registerHuaweiIPSecSystemCommands(t, this);

    // IPSec display commands
    registerHuaweiIPSecDisplayCommands(t, () => this.r());

    // ACL system-mode commands
    registerHuaweiACLSystemCommands(t, this);

    // ACL display commands
    registerHuaweiACLDisplayCommands(t, () => this.r());

    // NAT display commands
    registerHuaweiNATDisplayCommands(t, () => this.r());

    // DHCP display commands
    registerDhcpDisplayCommands(t, () => this.r());

    // DHCP debug/clear commands
    registerDhcpDebugCommands(t, () => this.r());

    t.register('save', 'Save current configuration', () => {
      return 'The current configuration will be written to the device.\nInfo: Please input the file name ( *.cfg, *.zip ) [vrpcfg.zip]:vrpcfg.zip\nNow saving the current configuration to the slot.\nSave the configuration successfully.';
    });

    registerHuaweiPolicySystemCommands(t, this);
    registerHuaweiPolicyDisplayCommands(t, () => this.r());

    for (const kw of ['ftp server enable', 'snmp-agent', 'info-center enable',
      'ntp-service enable', 'telnet server enable', 'http server',
      'icmp ttl-exceeded send', 'icmp host-unreachable send']) {
      t.register(kw, `Toggle: ${kw}`, () => {
        this.r()._setGlobalToggle?.(kw.replace(/\s+enable\s*$/, ''), true);
        return '';
      });
    }
    t.registerGreedy('ip routing-table limit', 'Configure IPv4 routing-table limit', (args) => {
      const r = this.routerRef as unknown as { _setRoutingTableLimit?: (max: number, thresholdPct?: number) => void } | null;
      if (!r) return '';
      const max = parseInt(args[0] ?? '', 10);
      const threshold = parseInt(args[1] ?? '', 10);
      if (!isNaN(max)) r._setRoutingTableLimit?.(max, isNaN(threshold) ? undefined : threshold);
      return '';
    });
    t.registerGreedy('undo ip routing-table limit', 'Remove routing-table limit', () => {
      const r = this.routerRef as unknown as { _setRoutingTableLimit?: (max: number | null) => void } | null;
      r?._setRoutingTableLimit?.(null);
      return '';
    });
    t.registerGreedy('ftp', 'FTP server config', (args) => {
      if (args[0] === 'server' && (args[1] === 'enable' || !args[1])) {
        this.r()._setGlobalToggle?.('ftp', true);
      }
      return '';
    });
  }

  // ─── Interface View ([hostname-GE0/0/X]) ─────────────────────────

  private buildInterfaceViewCommands(): void {
    const t = this.interfaceTrie;
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;

    // Display commands
    registerDisplayCommands(t, getRouter, getState);

    // OSPF display commands (available in interface view too)
    registerOSPFDisplayCommands(t, getRouter);

    // Interface-specific commands
    buildInterfaceCommands(t, this);

    // OSPF interface commands
    registerOSPFInterfaceCommands(t, this as any);

    // IPSec interface commands
    registerHuaweiIPSecInterfaceCommands(t, this);

    // ACL interface commands
    registerHuaweiACLInterfaceCommands(t, this);

    registerHuaweiNATInterfaceCommands(t, this);

    t.registerGreedy('traffic-policy', 'Apply traffic policy on interface', (args) => {
      const name = args[0]; const dir = (args[1] || 'inbound').toLowerCase();
      if (!name || !this.selectedInterface) return '';
      const d = dir === 'outbound' ? 'outbound' : 'inbound';
      this.r().getTrafficPolicyStore().apply(this.selectedInterface, name, d);
      return '';
    });
    t.registerGreedy('undo traffic-policy', 'Remove traffic policy from interface', (args) => {
      const dir = (args[0] || 'inbound').toLowerCase();
      if (!this.selectedInterface) return '';
      const d = dir === 'outbound' ? 'outbound' : 'inbound';
      this.r().getTrafficPolicyStore().removeApplication(this.selectedInterface, d);
      return '';
    });
  }

  // ─── DHCP Pool View ([hostname-ip-pool-name]) ────────────────────

  private buildDhcpPoolViewCommands(): void {
    buildDhcpPoolCommands(this.dhcpPoolTrie, this);
  }

  // ─── OSPF View ([hostname-ospf-1]) ────────────────────────────

  private buildOSPFViewCommands(): void {
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;
    registerDisplayCommands(this.ospfTrie, getRouter, getState);
    registerOSPFDisplayCommands(this.ospfTrie, getRouter);
    buildOSPFViewCommands(this.ospfTrie, this as any, (area) => { this.ospfArea = area; });
  }

  // ─── OSPFv3 View ([hostname-ospfv3-1]) ─────────────────────────

  private buildOSPFv3ViewCommands(): void {
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;
    registerDisplayCommands(this.ospfv3Trie, getRouter, getState);
    registerOSPFDisplayCommands(this.ospfv3Trie, getRouter);
    buildOSPFv3ViewCommands(this.ospfv3Trie, this as any);
  }

  // ─── IPSec Sub-Views ─────────────────────────────────────────

  private buildIPSecSubViewCommands(): void {
    buildHuaweiIKEProposalCommands(this.ikeProposalTrie, this);
    buildHuaweiIKEPeerCommands(this.ikePeerTrie, this);
    buildHuaweiIPSecProposalCommands(this.ipsecProposalTrie, this);
    buildHuaweiIPSecPolicyCommands(this.ipsecPolicyTrie, this);
  }

  // ─── IKEv2 Sub-Views ─────────────────────────────────────────

  private buildIKEv2SubViewCommands(): void {
    buildHuaweiIKEv2ProposalCommands(this.ikev2ProposalTrie, this);
    buildHuaweiIKEv2PolicyCommands(this.ikev2PolicyTrie, this);
    buildHuaweiIKEv2KeyringCommands(this.ikev2KeyringTrie, this);
    buildHuaweiIKEv2KeyringPeerCommands(this.ikev2KeyringPeerTrie, this);
    buildHuaweiIKEv2ProfileCommands(this.ikev2ProfileTrie, this);
  }

  // ─── ACL Sub-Views ──────────────────────────────────────────

  private buildACLSubViewCommands(): void {
    buildHuaweiBasicACLCommands(this.aclBasicTrie, this);
    buildHuaweiAdvancedACLCommands(this.aclAdvancedTrie, this);
  }

  // ─── OSPF Area View ([hostname-ospf-1-area-X]) ────────────────

  private buildOSPFAreaViewCommands(): void {
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;
    registerDisplayCommands(this.ospfAreaTrie, getRouter, getState);
    registerOSPFDisplayCommands(this.ospfAreaTrie, getRouter);
    buildOSPFAreaViewCommands(this.ospfAreaTrie, this as any, () => this.ospfArea);
  }

  // ─── RIP View ([hostname-rip-1]) ────────────────────────────────

  private buildRIPViewCommands(): void {
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;
    const t = this.ripTrie;

    registerDisplayCommands(t, getRouter, getState);

    t.registerGreedy('network', 'Advertise network in RIP', (args) => {
      if (args.length < 1) return 'Error: Incomplete command.';
      return cmdRip(getRouter(), ['network', ...args]);
    });

    t.registerGreedy('version', 'Set RIP version', (_args) => {
      return '';
    });

    t.registerGreedy('preference', 'Set RIP preference value', (_args) => {
      return '';
    });

    t.registerGreedy('undo network', 'Remove advertised network', (_args) => {
      return '';
    });
  }

  // ─── Tracert command ──────────────────────────────────────────────

  private _handleTracert(args: string[]): string {
    if (args.length === 0) {
      return 'Error: Please specify a destination IP address.';
    }

    let target = '';
    let maxHops = 30;
    let timeoutMs = 2000;
    let probesPerHop = 3;

    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-h' && args[i + 1]) { maxHops = parseInt(args[i + 1], 10) || 30; i++; }
      else if (a === '-w' && args[i + 1]) { timeoutMs = (parseInt(args[i + 1], 10) || 2) * 1000; i++; }
      else if (a === '-q' && args[i + 1]) { probesPerHop = parseInt(args[i + 1], 10) || 3; i++; }
      else if (!a.startsWith('-')) { target = args[i]; }
    }

    if (!target) return 'Error: Please specify a destination IP address.';

    const ipMatch = target.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipMatch) return `Error: Unknown host ${target}.`;
    const octets = [+ipMatch[1], +ipMatch[2], +ipMatch[3], +ipMatch[4]];
    if (octets.some(o => o > 255)) return `Error: Invalid IP address ${target}.`;

    const targetIP = new IPAddress(target);
    const router = this.r();

    this._pendingAsync = router.executeTraceroute(targetIP, maxHops, timeoutMs, probesPerHop).then(hops =>
      this._formatHuaweiTracert(target, maxHops, hops),
    );

    return '';
  }

  private _formatHuaweiTracert(
    target: string,
    maxHops: number,
    hops: Array<{ hop: number; ip?: string; rttMs?: number; timeout: boolean; unreachable?: boolean; probes?: Array<{ responded: boolean; rttMs?: number; ip?: string; unreachable?: boolean }> }>,
  ): string {
    const lines: string[] = [
      `tracert to ${target}(${target}), max hops: ${maxHops}, packet length: 40, press CTRL_C to break`,
    ];

    if (hops.length === 0) {
      lines.push(' Network is unreachable');
      return lines.join('\n');
    }

    for (const hop of hops) {
      if (hop.timeout && (!hop.probes || hop.probes.every(p => !p.responded))) {
        lines.push(` ${hop.hop}  *  *  *`);
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
            parts.push(`${Math.round(probe.rttMs ?? 0)} ms`);
          }
        }
        lines.push(` ${hop.hop} ${hop.ip}  ${parts.join(' ')}${annotation}`);
      } else {
        const ms = Math.round(hop.rttMs ?? 0);
        lines.push(` ${hop.hop} ${hop.ip}  ${ms} ms${annotation}`);
      }
    }

    return lines.join('\n');
  }

  // ─── Ping command ─────────────────────────────────────────────────

  private _handlePing(args: string[]): string {
    if (args.length === 0) return 'Error: Please specify a destination IP address.';

    let target = '';
    let count = 5;
    let timeoutMs = 2000;
    let sourceIP: string | null = null;

    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-c' && args[i + 1]) { count = parseInt(args[i + 1], 10) || 5; i++; }
      else if (a === '-t' && args[i + 1]) { timeoutMs = (parseInt(args[i + 1], 10) || 2) * 1000; i++; }
      else if (a === '-a' && args[i + 1]) { sourceIP = args[i + 1]; i++; }
      else if (!a.startsWith('-')) { target = args[i]; }
    }

    if (!target) return 'Error: Please specify a destination IP address.';

    const ipMatch = target.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipMatch) return `Error: Unknown host ${target}.`;
    const octets = [+ipMatch[1], +ipMatch[2], +ipMatch[3], +ipMatch[4]];
    if (octets.some(o => o > 255)) return `Error: Invalid IP address ${target}.`;

    const targetIP = new IPAddress(target);
    const router = this.r();

    this._pendingAsync = router.executePingSequence(targetIP, count, timeoutMs, sourceIP ?? undefined).then(results => {
      const successes = results.filter(r => r.success).length;
      const lines = [
        `PING ${target}: 56  data bytes, press CTRL_C to break`,
        ...results.map(r =>
          r.success
            ? `Reply from ${r.fromIP}: bytes=56 Sequence=${r.seq} ttl=${r.ttl} time=${r.rttMs.toFixed(0)} ms`
            : `Request timeout`,
        ),
        '',
        `--- ${target} ping statistics ---`,
        `${count} packet(s) transmitted, ${successes} packet(s) received, ${Math.round(((count - successes) / count) * 100)}% packet loss`,
      ];
      return lines.join('\n');
    });

    return '';
  }
}
