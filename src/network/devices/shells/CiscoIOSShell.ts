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
  registerACLShowCommands,
} from './cisco/CiscoAclCommands';
import {
  registerOSPFConfigCommands, buildConfigRouterOSPFCommands,
  registerOSPFInterfaceCommands, registerOSPFShowCommands,
} from './cisco/CiscoOspfCommands';

export class CiscoIOSShell implements IRouterShell, CiscoShellContext, CiscoACLShellContext {
  private mode: CiscoShellMode = 'user';
  private selectedInterface: string | null = null;
  private selectedDHCPPool: string | null = null;
  private selectedACL: string | null = null;
  private selectedACLType: 'standard' | 'extended' | null = null;

  /** Temporary reference set during execute() for closures */
  private routerRef: Router | null = null;

  // Per-mode command tries
  private userTrie = new CommandTrie();
  private privilegedTrie = new CommandTrie();
  private configTrie = new CommandTrie();
  private configIfTrie = new CommandTrie();
  private configDhcpTrie = new CommandTrie();
  private configRouterTrie = new CommandTrie();        // RIP config-router
  private configRouterOspfTrie = new CommandTrie();    // OSPF config-router
  private configStdNaclTrie = new CommandTrie();
  private configExtNaclTrie = new CommandTrie();

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
    // OSPF commands (separate trie from RIP)
    registerOSPFConfigCommands(this.configTrie, this);
    registerOSPFInterfaceCommands(this.configIfTrie, this);
    buildConfigRouterOSPFCommands(this.configRouterOspfTrie, this);
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

  // ─── Prompt Generation ─────────────────────────────────────────────

  getPrompt(router: Router): string {
    const host = router._getHostnameInternal();
    switch (this.mode) {
      case 'user':          return `${host}>`;
      case 'privileged':    return `${host}#`;
      case 'config':        return `${host}(config)#`;
      case 'config-if':     return `${host}(config-if)#`;
      case 'config-dhcp':   return `${host}(dhcp-config)#`;
      case 'config-router': return `${host}(config-router)#`;
      case 'config-router-ospf': return `${host}(config-router)#`;
      case 'config-std-nacl': return `${host}(config-std-nacl)#`;
      case 'config-ext-nacl': return `${host}(config-ext-nacl)#`;
      default:              return `${host}>`;
    }
  }

  // ─── Main Execute ──────────────────────────────────────────────────

  execute(router: Router, rawInput: string): string {
    const trimmed = rawInput.trim();
    if (!trimmed) return '';

    // Handle pipe filtering: "show logging | include DHCP"
    let pipeFilter: { type: string; pattern: string } | null = null;
    let cmdPart = trimmed;
    const pipeIdx = trimmed.indexOf(' | ');
    if (pipeIdx !== -1) {
      cmdPart = trimmed.substring(0, pipeIdx).trim();
      const filterPart = trimmed.substring(pipeIdx + 3).trim();
      const filterMatch = filterPart.match(/^(include|exclude|grep|findstr)\s+(.+)$/i);
      if (filterMatch) {
        pipeFilter = { type: filterMatch[1].toLowerCase(), pattern: filterMatch[2] };
      }
    }

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
      return this.applyPipeFilter(output, pipeFilter);
    }

    // Handle 'show' shortcut in config modes (real Cisco IOS behavior)
    if (this.mode !== 'user' && this.mode !== 'privileged' && lower.startsWith('show ')) {
      const savedMode = this.mode;
      this.mode = 'privileged';
      let output = this.executeOnTrie(cmdPart);
      this.mode = savedMode;
      this.routerRef = null;
      return this.applyPipeFilter(output, pipeFilter);
    }

    let output = this.executeOnTrie(cmdPart);
    this.routerRef = null;

    return this.applyPipeFilter(output, pipeFilter);
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
        return result.error || `% Ambiguous command: "${cmdPart}"`;

      case 'incomplete':
        return result.error || '% Incomplete command.';

      case 'invalid':
        return result.error || `% Invalid input detected at '^' marker.`;

      default:
        return `% Unrecognized command "${cmdPart}"`;
    }
  }

  private applyPipeFilter(output: string, pipeFilter: { type: string; pattern: string } | null): string {
    if (!pipeFilter || !output) return output;
    const lines = output.split('\n');
    let pattern = pipeFilter.pattern;
    if ((pattern.startsWith('"') && pattern.endsWith('"')) ||
        (pattern.startsWith("'") && pattern.endsWith("'"))) {
      pattern = pattern.slice(1, -1);
    }
    const lowerPattern = pattern.toLowerCase();
    if (pipeFilter.type === 'include' || pipeFilter.type === 'grep' || pipeFilter.type === 'findstr') {
      return lines.filter(l => l.toLowerCase().includes(lowerPattern)).join('\n');
    } else if (pipeFilter.type === 'exclude') {
      return lines.filter(l => !l.toLowerCase().includes(lowerPattern)).join('\n');
    }
    return output;
  }

  // ─── Help / Completion ─────────────────────────────────────────────

  getHelp(input: string): string {
    const trie = this.getActiveTrie();
    const completions = trie.getCompletions(input);
    if (completions.length === 0) return '% Unrecognized command';
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
      case 'config-std-nacl': return this.configStdNaclTrie;
      case 'config-ext-nacl': return this.configExtNaclTrie;
      default: return this.userTrie;
    }
  }

  // ─── FSM Transitions ──────────────────────────────────────────────

  private cmdExit(): string {
    switch (this.mode) {
      case 'config-if':
      case 'config-dhcp':
      case 'config-router':
      case 'config-router-ospf':
      case 'config-std-nacl':
      case 'config-ext-nacl':
        this.mode = 'config';
        this.selectedInterface = null;
        this.selectedDHCPPool = null;
        this.selectedACL = null;
        this.selectedACLType = null;
        return '';
      case 'config':
        this.mode = 'privileged';
        return '';
      case 'privileged':
        this.mode = 'user';
        return '';
      case 'user':
        return '';
      default:
        return '';
    }
  }

  private cmdEnd(): string {
    if (this.mode !== 'user' && this.mode !== 'privileged') {
      this.mode = 'privileged';
      this.selectedInterface = null;
      this.selectedDHCPPool = null;
      this.selectedACL = null;
      this.selectedACLType = null;
    }
    return '';
  }

  // ═══════════════════════════════════════════════════════════════════
  // Command Registration (per-mode CommandTrie construction)
  // ═══════════════════════════════════════════════════════════════════

  // ─── User EXEC Mode (>) ──────────────────────────────────────────

  private buildUserCommands(): void {
    const t = this.userTrie;

    t.register('enable', 'Enter privileged EXEC mode', () => {
      this.mode = 'privileged';
      return '';
    });

    // show commands (limited in user mode)
    this.registerShowCommands(t);

    t.registerGreedy('ping', 'Send echo messages', () => {
      return '% Use "enable" to access privileged commands first.';
    });
  }

  // ─── Privileged EXEC Mode (#) ─────────────────────────────────────

  private buildPrivilegedCommands(): void {
    const t = this.privilegedTrie;

    t.register('enable', 'Enter privileged EXEC mode (already in)', () => '');

    t.register('configure terminal', 'Enter configuration mode', () => {
      this.mode = 'config';
      return 'Enter configuration commands, one per line.  End with CNTL/Z.';
    });

    t.register('disable', 'Return to user EXEC mode', () => {
      this.mode = 'user';
      return '';
    });

    t.register('copy running-config startup-config', 'Save configuration', () => {
      return '[OK]';
    });

    t.register('write memory', 'Save configuration', () => {
      return 'Building configuration...\n[OK]';
    });

    // show commands
    this.registerShowCommands(t);

    // DHCP privileged commands (debug, clear)
    registerDhcpPrivilegedCommands(t, () => this.r());

    // ping (greedy to accept IP/hostname)
    t.registerGreedy('ping', 'Send echo messages', () => {
      return '% Ping requires a target IP address.';
    });
  }

  // ─── Shared Show Commands ──────────────────────────────────────────

  private registerShowCommands(trie: CommandTrie): void {
    const getRouter = () => this.r();

    trie.register('show ip route', 'Display IP routing table', () => Show.showIpRoute(getRouter()));
    trie.register('show ip interface brief', 'Display interface status summary', () => Show.showIpIntBrief(getRouter()));
    trie.register('show arp', 'Display ARP table', () => Show.showArp(getRouter()));
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

    // show running-config interface <name>
    trie.registerGreedy('show running-config interface', 'Display interface running config', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const ifName = resolveInterfaceName(getRouter(), args.join(' '));
      if (!ifName) return `% Invalid interface`;
      return Show.showRunningConfigInterface(getRouter(), ifName);
    });

    trie.register('show version', 'Display system hardware and software status', () => Show.showVersion(getRouter()));
  }
}
