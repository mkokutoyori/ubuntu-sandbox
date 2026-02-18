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
} from './huawei/HuaweiDhcpCommands';

export class HuaweiVRPShell implements IRouterShell, HuaweiShellContext, HuaweiDisplayState {
  private mode: HuaweiShellMode = 'user';
  private selectedInterface: string | null = null;
  private selectedPool: string | null = null;
  private dhcpEnabled: boolean = false;
  private dhcpSnoopingEnabled: boolean = false;
  /** Track which interfaces have 'dhcp select global' */
  private dhcpSelectGlobalSet: Set<string> = new Set();

  /** Temporary reference set during execute() */
  private routerRef: Router | null = null;

  // Per-mode command tries
  private userTrie = new CommandTrie();
  private systemTrie = new CommandTrie();
  private interfaceTrie = new CommandTrie();
  private dhcpPoolTrie = new CommandTrie();

  constructor() {
    this.buildUserCommands();
    this.buildSystemViewCommands();
    this.buildInterfaceViewCommands();
    this.buildDhcpPoolViewCommands();
  }

  getOSType(): string { return 'huawei-vrp'; }

  // ─── HuaweiShellContext Implementation ──────────────────────────────

  r(): Router {
    if (!this.routerRef) throw new Error('Router reference not set (BUG)');
    return this.routerRef;
  }

  setMode(mode: HuaweiShellMode): void { this.mode = mode; }

  getSelectedInterface(): string | null { return this.selectedInterface; }
  setSelectedInterface(iface: string | null): void { this.selectedInterface = iface; }

  getSelectedPool(): string | null { return this.selectedPool; }
  setSelectedPool(pool: string | null): void { this.selectedPool = pool; }

  getDhcpSelectGlobal(): Set<string> { return this.dhcpSelectGlobalSet; }

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
      return '';
    }
    if (lower === 'quit') return this.cmdQuit();

    // Bind router reference
    this.routerRef = router;

    const output = this.executeOnTrie(trimmed);

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
        return result.error || `Error: Ambiguous command "${cmdPart}"`;

      case 'incomplete':
        return result.error || 'Error: Incomplete command.';

      case 'invalid':
        return result.error || `Error: Unrecognized command "${cmdPart}"`;

      default:
        return `Error: Unrecognized command "${cmdPart}"`;
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
  }

  // ─── Interface View ([hostname-GE0/0/X]) ─────────────────────────

  private buildInterfaceViewCommands(): void {
    const t = this.interfaceTrie;
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;

    // Display commands
    registerDisplayCommands(t, getRouter, getState);

    // Interface-specific commands
    buildInterfaceCommands(t, this);
  }

  // ─── DHCP Pool View ([hostname-ip-pool-name]) ────────────────────

  private buildDhcpPoolViewCommands(): void {
    buildDhcpPoolCommands(this.dhcpPoolTrie, this);
  }
}
