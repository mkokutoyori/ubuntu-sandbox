/**
 * HuaweiVRPShell - Huawei VRP CLI emulation for Router Management Plane
 *
 * Modes:
 *   - User view: <hostname> — display commands, ping, traceroute
 *   - System view: [hostname] — configuration commands
 *   - Interface view: [hostname-GE0/0/X] — interface configuration
 *   - DHCP pool view: [hostname-ip-pool-name] — DHCP pool configuration
 *
 * Command implementations are extracted into:
 *   - huawei/HuaweiDisplayCommands.ts  — display implementations
 *   - huawei/HuaweiConfigCommands.ts   — config/interface commands
 *   - huawei/HuaweiDhcpCommands.ts     — DHCP commands
 */

import type { Router } from '../Router';
import type { IRouterShell } from './IRouterShell';

// Extracted command modules
import { dispatchDisplay, resolveHuaweiInterfaceName } from './huawei/HuaweiDisplayCommands';
import {
  type HuaweiShellMode, type HuaweiShellContext,
  cmdIp, cmdArpStatic, cmdRip, cmdUndo, executeInterfaceMode,
} from './huawei/HuaweiConfigCommands';
import { cmdDhcp, executeDhcpPoolMode } from './huawei/HuaweiDhcpCommands';

export class HuaweiVRPShell implements IRouterShell, HuaweiShellContext {
  private mode: HuaweiShellMode = 'user';
  private selectedInterface: string | null = null;
  private selectedPool: string | null = null;
  private dhcpEnabled: boolean = false;
  private dhcpSnoopingEnabled: boolean = false;
  /** Track which interfaces have 'dhcp select global' */
  private dhcpSelectGlobalSet: Set<string> = new Set();

  /** Temporary reference set during execute() */
  private routerRef: Router | null = null;

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

    let output: string;
    switch (this.mode) {
      case 'user':       output = this.executeUserMode(router, trimmed); break;
      case 'system':     output = this.executeSystemMode(router, trimmed); break;
      case 'interface':  output = this.executeInterfaceMode(router, trimmed); break;
      case 'dhcp-pool':  output = executeDhcpPoolMode(router, this, trimmed); break;
      default:           output = `Error: Unrecognized command "${trimmed}"`;
    }

    this.routerRef = null;
    return output;
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

  // ─── User View (<hostname>) ──────────────────────────────────────

  private executeUserMode(router: Router, input: string): string {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'system-view') {
      this.mode = 'system';
      return 'Enter system view, return user view with return command.';
    }

    if (cmd === 'display') return dispatchDisplay(router, parts.slice(1), this.dhcpEnabled, this.dhcpSnoopingEnabled, this.dhcpSelectGlobalSet);
    if (cmd === 'show') return dispatchDisplay(router, parts.slice(1), this.dhcpEnabled, this.dhcpSnoopingEnabled, this.dhcpSelectGlobalSet); // alias

    // Allow config commands in user view for backward compatibility
    if (cmd === 'ip') return cmdIp(router, this, parts.slice(1));
    if (cmd === 'rip') return cmdRip(router, parts.slice(1));
    if (cmd === 'undo') return cmdUndo(router, this, parts.slice(1));

    return `Error: Unrecognized command "${input}"`;
  }

  // ─── System View ([hostname]) ────────────────────────────────────

  private executeSystemMode(router: Router, input: string): string {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'display') return dispatchDisplay(router, parts.slice(1), this.dhcpEnabled, this.dhcpSnoopingEnabled, this.dhcpSelectGlobalSet);

    if (cmd === 'sysname') {
      if (parts.length < 2) return 'Error: Incomplete command.';
      router._setHostnameInternal(parts[1]);
      return '';
    }

    if (cmd === 'interface') {
      if (parts.length < 2) return 'Error: Incomplete command.';
      const portName = resolveHuaweiInterfaceName(router, parts[1]);
      if (!portName) return `Error: Wrong parameter found at '^' position.`;
      this.selectedInterface = portName;
      this.mode = 'interface';
      return '';
    }

    if (cmd === 'ip') return cmdIp(router, this, parts.slice(1));
    if (cmd === 'undo') return cmdUndo(router, this, parts.slice(1));
    if (cmd === 'rip') return cmdRip(router, parts.slice(1));

    if (cmd === 'arp') {
      // arp static <ip> <mac>
      if (parts.length >= 4 && parts[1].toLowerCase() === 'static') {
        return cmdArpStatic(router, parts[2], parts[3]);
      }
      return 'Error: Incomplete command.';
    }

    if (cmd === 'dhcp') {
      return cmdDhcp(router, this, parts.slice(1),
        (v) => { this.dhcpEnabled = v; },
        (v) => { this.dhcpSnoopingEnabled = v; },
      );
    }

    return `Error: Unrecognized command "${input}"`;
  }

  // ─── Interface View ([hostname-GE0/0/X]) ─────────────────────────

  private executeInterfaceMode(router: Router, input: string): string {
    const parts = input.split(/\s+/);

    if (input.toLowerCase() === 'display') return 'Error: Incomplete command.';
    if (parts[0].toLowerCase() === 'display') return dispatchDisplay(router, parts.slice(1), this.dhcpEnabled, this.dhcpSnoopingEnabled, this.dhcpSelectGlobalSet);

    const result = executeInterfaceMode(router, this, input);
    if (result !== null) return result;

    return `Error: Unrecognized command "${input}"`;
  }
}
