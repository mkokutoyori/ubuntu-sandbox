/**
 * CiscoIOSShell - Cisco IOS CLI emulation for Router Management Plane
 *
 * FSM-based CLI with CommandTrie for abbreviation/help support:
 *   user        — Router>           (limited show commands)
 *   privileged  — Router#           (full show/debug/clear + configure)
 *   config      — Router(config)#   (global configuration)
 *   config-if   — Router(config-if)# (interface configuration)
 *   config-dhcp — Router(dhcp-config)# (DHCP pool configuration)
 *   config-router — Router(config-router)# (routing protocol config)
 *
 * Features:
 *   - Abbreviation matching (e.g. "sh ip ro" → "show ip route")
 *   - Context-aware ? help listing valid completions
 *   - Pipe filtering: "show ... | include <pattern>"
 *   - 'do' prefix in config modes (execute privileged command)
 *   - 'show' shortcut in config modes
 *
 * Command implementations are extracted into:
 *   - cisco/CiscoShowCommands.ts    — show implementations
 *   - cisco/CiscoConfigCommands.ts  — config/config-if commands
 *   - cisco/CiscoDhcpCommands.ts    — DHCP commands
 *   - cisco/CiscoRipCommands.ts     — RIP commands
 */

import type { Router } from '../Router';
import type { IRouterShell } from './IRouterShell';
import { CommandTrie } from './CommandTrie';
import { IPAddress } from '../../core/types';
import {
  CISCO_ERRORS, parsePipeFilter, applyPipeFilter,
} from './cli-utils';
import { buildPrompt, CISCO_IOS_PROMPTS } from './PromptBuilder';
import { CLIStateMachine, CISCO_IOS_MODES } from './CLIStateMachine';
import { registerSharedUserCommands, registerSharedPrivilegedCommands } from './cisco/CiscoSharedCommands';

// Extracted command modules
import * as Show from './cisco/CiscoShowCommands';
import {
  type CiscoShellMode, type CiscoShellContext,
  buildConfigCommands, buildConfigIfCommands,
  resolveInterfaceName,
} from './cisco/CiscoConfigCommands';
import {
  buildConfigDhcpCommands,
  registerDhcpShowCommands,
  registerDhcpPrivilegedCommands,
} from './cisco/CiscoDhcpCommands';
import { buildConfigRouterCommands } from './cisco/CiscoRipCommands';
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

export class CiscoIOSShell implements IRouterShell, CiscoShellContext, CiscoACLShellContext {
  private mode: CiscoShellMode = 'user';
  private selectedInterface: string | null = null;
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

  /** FSM for mode transitions (exit/end) */
  private readonly fsm = new CLIStateMachine<CiscoShellMode>('user', CISCO_IOS_MODES, 'user', 'privileged');

  /** Temporary reference set during execute() for closures */
  private routerRef: Router | null = null;
  /** When a command needs async execution (e.g. ping), it stores a promise here */
  private _pendingAsync: Promise<string> | null = null;

  // Per-mode command tries
  private userTrie = new CommandTrie();
  private privilegedTrie = new CommandTrie();
  private configTrie = new CommandTrie();
  private configIfTrie = new CommandTrie();
  private configDhcpTrie = new CommandTrie();
  private configRouterTrie = new CommandTrie();        // RIP config-router
  private configRouterOspfTrie = new CommandTrie();    // OSPF config-router
  private configRouterOspfv3Trie = new CommandTrie();  // OSPFv3 config-router
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
    this.buildUserCommands();
    this.buildPrivilegedCommands();
    buildConfigCommands(this.configTrie, this);
    buildConfigIfCommands(this.configIfTrie, this);
    buildACLConfigCommands(this.configTrie, this);
    buildACLInterfaceCommands(this.configIfTrie, this);
    buildConfigDhcpCommands(this.configDhcpTrie, this);
    buildConfigRouterCommands(this.configRouterTrie, this);
    buildNamedStdACLCommands(this.configStdNaclTrie, this);
    buildNamedExtACLCommands(this.configExtNaclTrie, this);
    buildIPv6ACLGlobalCommands(this.configTrie, this);
    buildIPv6ACLModeCommands(this.configIpv6NaclTrie, this);
    // OSPF commands (separate trie from RIP)
    registerOSPFConfigCommands(this.configTrie, this);
    registerOSPFInterfaceCommands(this.configIfTrie, this);
    buildConfigRouterOSPFCommands(this.configRouterOspfTrie, this);
    buildConfigRouterOSPFv3Commands(this.configRouterOspfv3Trie, this);
    // IPSec commands
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

  getOSType(): string { return 'cisco-ios'; }

  getMode(): CiscoShellMode { return this.mode; }

  // ─── CiscoShellContext Implementation ───────────────────────────────

  r(): Router {
    if (!this.routerRef) throw new Error('Router reference not set (BUG)');
    return this.routerRef;
  }

  setMode(mode: CiscoShellMode): void { this.mode = mode; }

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

  // ─── Prompt Generation ─────────────────────────────────────────────

  getPrompt(router: Router): string {
    return buildPrompt(this.mode, router._getHostnameInternal(), CISCO_IOS_PROMPTS);
  }

  // ─── Main Execute ──────────────────────────────────────────────────

  execute(router: Router, rawInput: string): string | Promise<string> {
    const trimmed = rawInput.trim();
    if (!trimmed) return '';

    // Handle pipe filtering: "show logging | include DHCP"
    const { cmd: cmdPart, filter: pipeFilter } = parsePipeFilter(trimmed);

    // Handle ? for help (preserve trailing space for "show ?" vs "show?")
    if (cmdPart.endsWith('?')) {
      const helpInput = cmdPart.slice(0, -1);
      return this.getHelp(helpInput);
    }

    // Global shortcuts
    const lower = cmdPart.toLowerCase();
    if (lower === 'exit') return this.cmdExit();
    if (lower === 'end') return this.cmdEnd();
    if (lower === 'logout' && this.mode === 'user') return 'Connection closed.';
    if (lower === 'disable' && this.mode === 'privileged') {
      this.mode = 'user';
      return '';
    }

    // Bind router reference for command closures
    this.routerRef = router;

    // Handle 'do' prefix in config modes
    if (this.mode !== 'user' && this.mode !== 'privileged' && lower.startsWith('do ')) {
      const subCmd = cmdPart.slice(3).trim();
      const savedMode = this.mode;
      this.mode = 'privileged';
      let output = this.executeOnTrie(subCmd);
      this.mode = savedMode;
      this.routerRef = null;
      return applyPipeFilter(output, pipeFilter);
    }

    // Handle 'show' shortcut in config modes (real Cisco IOS behavior)
    if (this.mode !== 'user' && this.mode !== 'privileged' && lower.startsWith('show ')) {
      const savedMode = this.mode;
      this.mode = 'privileged';
      let output = this.executeOnTrie(cmdPart);
      this.mode = savedMode;
      this.routerRef = null;
      return applyPipeFilter(output, pipeFilter);
    }

    let output = this.executeOnTrie(cmdPart);

    // Check if the command set up an async operation (e.g. ping)
    if (this._pendingAsync) {
      const asyncOp = this._pendingAsync;
      this._pendingAsync = null;
      this.routerRef = null;
      return asyncOp.then(result => applyPipeFilter(result, pipeFilter));
    }

    this.routerRef = null;

    return applyPipeFilter(output, pipeFilter);
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
        return result.error || CISCO_ERRORS.AMBIGUOUS(cmdPart);

      case 'incomplete':
        return result.error || CISCO_ERRORS.INCOMPLETE;

      case 'invalid':
        return result.error || CISCO_ERRORS.INVALID_INPUT;

      default:
        return CISCO_ERRORS.UNRECOGNIZED(cmdPart);
    }
  }

  // ─── Ping Command ──────────────────────────────────────────────────

  private _handlePing(args: string[]): string {
    if (args.length === 0) {
      return '% Ping requires a target IP address.';
    }

    // Parse ping options: ping <target> [source <ip|iface>] [repeat <count>] [timeout <sec>] [size <bytes>]
    let target = '';
    let count = 5;
    let timeoutMs = 2000;
    let sourceIP: string | null = null;

    let i = 0;
    // First non-keyword arg is the target
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
        // Accept but don't change actual payload (simulation)
        i += 2;
      } else {
        i++;
      }
    }

    if (!target) {
      return '% Ping requires a target IP address.';
    }

    // Validate IP
    const ipMatch = target.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipMatch) {
      return `% Unrecognized host or address, or protocol not running.`;
    }
    const octets = [+ipMatch[1], +ipMatch[2], +ipMatch[3], +ipMatch[4]];
    if (octets.some(o => o > 255)) {
      return `% Unrecognized host or address, or protocol not running.`;
    }

    // Resolve source interface name to IP if needed
    if (sourceIP) {
      const router = this.r();
      const resolved = this._resolveSourceIP(router, sourceIP);
      if (resolved) sourceIP = resolved;
    }

    const targetIP = new IPAddress(target);
    const router = this.r();

    // Store async operation — execute() will detect this and return the promise
    this._pendingAsync = router.executePingSequence(targetIP, count, timeoutMs, sourceIP ?? undefined).then(results => {
      return this._formatCiscoPing(target, count, timeoutMs, results);
    });

    return ''; // placeholder, execute() returns the promise instead
  }

  private _resolveSourceIP(router: any, source: string): string | null {
    // If it looks like an IP address, return as-is
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(source)) return source;
    // Otherwise try to resolve as interface name
    const ports = router._getPortsInternal?.() as Map<string, any> | undefined;
    if (!ports) return null;
    // Try exact match first
    const port = ports.get(source);
    if (port) {
      const ip = port.getIPAddress?.();
      return ip ? ip.toString() : null;
    }
    // Try resolving interface name (e.g., "Loopback0" -> "Loopback0")
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

    // Build the "!!!!!" or "....." line
    const chars = results.map(r => r.success ? '!' : '.');
    // If no results at all (unreachable), show dots
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
      // Append round-trip info on same line
      lines[lines.length - 1] += `, round-trip min/avg/max = ${min.toFixed(0)}/${avg.toFixed(0)}/${max.toFixed(0)} ms`;
    }

    return lines.join('\n');
  }

  // Pipe filter delegated to shared cli-utils.applyPipeFilter

  // ─── Help / Completion ─────────────────────────────────────────────

  getHelp(input: string): string {
    const trie = this.getActiveTrie();
    const completions = trie.getCompletions(input);
    if (completions.length === 0) return CISCO_ERRORS.UNRECOGNIZED_HELP;
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
      case 'privileged': return this.privilegedTrie;
      case 'config': return this.configTrie;
      case 'config-if': return this.configIfTrie;
      case 'config-dhcp': return this.configDhcpTrie;
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

  // ─── FSM Transitions ──────────────────────────────────────────────

  private cmdExit(): string {
    this.fsm.mode = this.mode;
    const { newMode, fieldsToCllear } = this.fsm.exit();
    this.mode = newMode;
    this.clearFields(fieldsToCllear);
    return '';
  }

  private cmdEnd(): string {
    this.fsm.mode = this.mode;
    const { newMode, fieldsToCllear } = this.fsm.end();
    this.mode = newMode;
    this.clearFields(fieldsToCllear);
    return '';
  }

  private clearFields(fields: string[]): void {
    for (const f of fields) {
      if (f === 'selectedInterface') this.selectedInterface = null;
      if (f === 'selectedDHCPPool') this.selectedDHCPPool = null;
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

  // ═══════════════════════════════════════════════════════════════════
  // Command Registration (per-mode CommandTrie construction)
  // ═══════════════════════════════════════════════════════════════════

  // ─── User EXEC Mode (>) ──────────────────────────────────────────

  private buildUserCommands(): void {
    const t = this.userTrie;

    // Shared Cisco commands (enable)
    registerSharedUserCommands(t, (m) => { this.mode = m as CiscoShellMode; });

    // show commands (limited in user mode)
    this.registerShowCommands(t);

    // ping is available in user mode on real Cisco IOS
    t.registerGreedy('ping', 'Send echo messages', (args) => {
      return this._handlePing(args);
    });
  }

  // ─── Privileged EXEC Mode (#) ─────────────────────────────────────

  private buildPrivilegedCommands(): void {
    const t = this.privilegedTrie;

    // Shared Cisco commands (enable, configure terminal, disable, write memory, copy running-config)
    registerSharedPrivilegedCommands(t, {
      setMode: (m) => { this.mode = m as CiscoShellMode; },
    });

    // show commands
    this.registerShowCommands(t);

    // Clear ARP cache
    t.register('clear arp-cache', 'Clear ARP cache', () => {
      this.r()._clearARPCache();
      return '';
    });

    // DHCP privileged commands (debug, clear)
    registerDhcpPrivilegedCommands(t, () => this.r());

    // IPSec privileged commands (clear crypto ...)
    buildIPSecPrivilegedCommands(t, this);

    // ping (greedy to accept IP/hostname)
    t.registerGreedy('ping', 'Send echo messages', (args) => {
      return this._handlePing(args);
    });
  }

  // ─── Shared Show Commands ──────────────────────────────────────────

  private registerShowCommands(trie: CommandTrie): void {
    const getRouter = () => this.r();

    trie.register('show ip route', 'Display IP routing table', () => Show.showIpRoute(getRouter()));
    trie.register('show ip interface brief', 'Display interface status summary', () => Show.showIpIntBrief(getRouter()));
    trie.registerGreedy('show arp', 'Display ARP table', (args) => Show.showArp(getRouter(), args.length > 0 ? args : undefined));
    trie.registerGreedy('show ip arp', 'Display ARP table', (args) => Show.showArp(getRouter(), args.length > 0 ? args : undefined));
    trie.register('show running-config', 'Display running configuration', () => Show.showRunningConfig(getRouter()));
    trie.register('show counters', 'Display traffic counters', () => Show.showCounters(getRouter()));
    trie.register('show ip traffic', 'Display IP traffic statistics', () => Show.showCounters(getRouter()));
    trie.register('show ip protocols', 'Display routing protocol status', () => Show.showIpProtocols(getRouter()));
    trie.register('show ip rip', 'Display RIP information', () => Show.showIpProtocols(getRouter()));

    // DHCP show commands
    registerDhcpShowCommands(trie, getRouter);

    // ACL show commands
    registerACLShowCommands(trie, getRouter);

    // OSPF show commands
    registerOSPFShowCommands(trie, getRouter);

    // IPSec show commands
    registerIPSecShowCommands(trie, getRouter);

    // show running-config interface <name>
    trie.registerGreedy('show running-config interface', 'Display interface running config', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const ifName = resolveInterfaceName(getRouter(), args.join(' '));
      if (!ifName) return `% Invalid interface`;
      return Show.showRunningConfigInterface(getRouter(), ifName);
    });

    trie.register('show version', 'Display system hardware and software status', () => Show.showVersion(getRouter()));

    trie.registerGreedy('show interface', 'Display interface status', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const ifName = resolveInterfaceName(getRouter(), args.join(' '));
      if (!ifName) return `% Invalid input detected at '^' marker.\nshow interface ${args.join(' ')}\n     ^`;
      return Show.showInterface(getRouter(), ifName);
    });
  }
}
