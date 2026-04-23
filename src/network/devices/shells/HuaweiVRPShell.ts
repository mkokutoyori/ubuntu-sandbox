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
import { CommandTrie } from './CommandTrie';
import { HUAWEI_ERRORS } from './cli-utils';
import { IPAddress } from '../../core/types';

// Extracted command modules
import {
  type HuaweiDisplayState,
  registerDisplayCommands,
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
} from './huawei/HuaweiIPSecCommands';
import {
  type HuaweiACLContext, type HuaweiACLMode,
  registerHuaweiACLSystemCommands, registerHuaweiACLInterfaceCommands,
  registerHuaweiACLDisplayCommands,
  buildHuaweiBasicACLCommands, buildHuaweiAdvancedACLCommands,
  runningConfigACL, runningConfigInterfaceACL,
} from './huawei/HuaweiAclCommands';

export class HuaweiVRPShell implements IRouterShell, HuaweiShellContext, HuaweiDisplayState, HuaweiIPSecContext, HuaweiACLContext {
  private mode: HuaweiShellMode | string = 'user';
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

  /** Temporary reference set during execute() */
  private routerRef: Router | null = null;
  /** Pending async operation (e.g. tracert) — set by a command handler, consumed by execute() */
  private _pendingAsync: Promise<string> | null = null;

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
  // ACL sub-mode tries
  private aclBasicTrie = new CommandTrie();
  private aclAdvancedTrie = new CommandTrie();
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
    this.buildACLSubViewCommands();
    this.buildRIPViewCommands();
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

  // ─── HuaweiDisplayState Implementation ─────────────────────────────

  isDhcpEnabled(): boolean { return this.dhcpEnabled; }
  isDhcpSnoopingEnabled(): boolean { return this.dhcpSnoopingEnabled; }

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
      case 'ike-proposal':  return `[${host}-ike-proposal-${this.selectedIKEProposal}]`;
      case 'ike-peer':      return `[${host}-ike-peer-${this.selectedIKEPeer}]`;
      case 'ipsec-proposal': return `[${host}-ipsec-proposal-${this.selectedIPSecProposal}]`;
      case 'ipsec-policy':  return `[${host}-ipsec-policy-${this.selectedIPSecPolicy}-${this.selectedIPSecPolicySeq}]`;
      case 'acl-basic':    return `[${host}-acl-basic-${this.selectedACLNumber}]`;
      case 'acl-advanced': return `[${host}-acl-adv-${this.selectedACLNumber}]`;
      default:           return `<${host}>`;
    }
  }

  // ─── Main Execute ──────────────────────────────────────────────────

  execute(router: Router, rawInput: string): string {
    const trimmed = rawInput.trim();
    if (!trimmed) return '';

    const lower = trimmed.toLowerCase();

    // Handle ? for help (preserve trailing space for "display ?" vs "display?")
    if (trimmed.endsWith('?')) {
      const helpInput = trimmed.slice(0, -1);
      return this.getHelp(helpInput);
    }

    // Global navigation
    if (lower === 'return') {
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
      return '';
    }
    if (lower === 'quit') return this.cmdQuit();

    // Bind router reference
    this.routerRef = router;

    const output = this.executeOnTrie(trimmed);

    // Async escape hatch (e.g. tracert sets _pendingAsync)
    if (this._pendingAsync) {
      const asyncOp = this._pendingAsync;
      this._pendingAsync = null;
      this.routerRef = null;
      return asyncOp;
    }

    this.routerRef = null;
    return output;
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
      case 'acl-basic': return this.aclBasicTrie;
      case 'acl-advanced': return this.aclAdvancedTrie;
      default: return this.userTrie;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Command Registration (per-mode CommandTrie construction)
  // ═══════════════════════════════════════════════════════════════════

  // ─── User View (<hostname>) ──────────────────────────────────────

  private buildUserCommands(): void {
    const t = this.userTrie;
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;

    t.register('system-view', 'Enter system view', () => {
      this.mode = 'system';
      return 'Enter system view, return user view with return command.';
    });

    // Display commands
    registerDisplayCommands(t, getRouter, getState);

    // OSPF display commands
    registerOSPFDisplayCommands(t, getRouter);

    // IPSec display commands
    registerHuaweiIPSecDisplayCommands(t, getRouter);

    // ACL display commands
    registerHuaweiACLDisplayCommands(t, getRouter);

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

    // DHCP display commands
    registerDhcpDisplayCommands(t, getRouter);

    // DHCP debug/clear commands
    registerDhcpDebugCommands(t, getRouter);
  }

  // ─── System View ([hostname]) ────────────────────────────────────

  private buildSystemViewCommands(): void {
    const t = this.systemTrie;
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;

    // Display commands (available in all modes)
    registerDisplayCommands(t, getRouter, getState);

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

    // DHCP display commands
    registerDhcpDisplayCommands(t, () => this.r());

    // DHCP debug/clear commands
    registerDhcpDebugCommands(t, () => this.r());

    // save — persist configuration
    t.register('save', 'Save current configuration', () => {
      return 'The current configuration will be written to the device.\nInfo: Please input the file name ( *.cfg, *.zip ) [vrpcfg.zip]:vrpcfg.zip\nNow saving the current configuration to the slot.\nSave the configuration successfully.';
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
