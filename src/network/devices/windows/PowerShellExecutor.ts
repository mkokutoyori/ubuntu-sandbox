/**
 * PowerShellExecutor — PowerShell cmdlet execution engine.
 *
 * Decoupled from React/UI. Handles:
 *   - PowerShell variable resolution ($PSVersionTable, $env:, etc.)
 *   - Cmdlet → device command mapping with PS-style output formatting
 *   - Pipeline operators (Where-Object, Select-String, Sort-Object, etc.)
 *   - PS-specific error formatting
 *
 * Used by WindowsTerminal to process commands when in PowerShell mode.
 */

import type { WindowsFileSystem, WinDirEntry } from './WindowsFileSystem';
import type { Port } from '../../hardware/Port';
import type { WindowsUserManager } from './WindowsUserManager';
import type { WindowsServiceManager } from './WindowsServiceManager';
import type { WindowsProcessManager } from './WindowsProcessManager';
import { isValidIPv4, isValidIPv6 } from '../../core/ip';
import type { IPAddress, SubnetMask } from '../../core/types';
import { toDisplayName, toPortName, formatLinkSpeedMbps } from './WindowsInterfaceNaming';
import {
  runPipeline, formatDefault, formatTable,
  buildProcessObjects, buildServiceObjects, buildCommandObjects,
  parseTable, parseKeyValueBlocks,
  type PSObject, type PipelineInput,
} from './PSPipeline';
import { psGetProcess, psStopProcess, psStartProcess, buildDynamicProcessObjects } from './PSProcessCmdlets';
import {
  psGetService, psStartService, psStopService, psRestartService,
  psSetService, psSuspendService, psResumeService,
  psNewService, psRemoveService, buildDynamicServiceObjects,
} from './PSServiceCmdlets';
import { PSRegistryProvider, isRegistryPath } from './PSRegistryProvider';
import { PSEventLogProvider } from './PSEventLogProvider';
import type { VpnConnectionInfo } from '@/powershell/providers/PSProviders';
import { parsePSArgs } from './psArgs';
import { psAddVpnConnection, psGetVpnConnection, psSetVpnConnection, psRemoveVpnConnection } from './PSVpnCmdlets';
import { psNewNetFirewallRule, psSetNetFirewallRule, psToggleNetFirewallRule, psRemoveNetFirewallRule, psGetNetFirewallRule } from './PSFirewallCmdlets';
import { LOCAL_ACCOUNT_CMDLETS } from './PSLocalAccountCmdlets';
import { EVENT_LOG_CMDLETS } from './PSEventLogCmdlets';
import { STORAGE_CMDLETS } from './PSStorageCmdlets';
import { psGetDnsClientServerAddress, psSetDnsClientServerAddress, psGetNetConnectionProfile, psSetNetConnectionProfile, type PSNetConfigContext } from './PSNetConfigCmdlets';
import { psTestPath, psResolvePath, psSplitPath, psJoinPath, type PSPathContext } from './PSPathCmdlets';
import { formatGetHelp } from './PSHelpText';
import { psGetItemProperty, psSetItemProperty, psRemoveItemProperty } from './PSRegistryCmdlets';
import * as net from './PSNetCmdlets';
import type { PSNetContext } from './PSNetCmdlets';
import type { IEventBus } from '@/events/EventBus';

// ─── Constants ────────────────────────────────────────────────────

export const PS_VERSION_TABLE = `
Name                           Value
----                           -----
PSVersion                      5.1.22621.4391
PSEdition                      Desktop
PSCompatibleVersions           {1.0, 2.0, 3.0, 4.0...}
BuildVersion                   10.0.22621.4391
CLRVersion                     4.0.30319.42000
WSManStackVersion              3.0
PSRemotingProtocolVersion      2.3
SerializationVersion           1.1.0.1`.trim();

// Re-export for backwards compatibility — the canonical home is now PSConstants.
export { PS_BANNER, PS_CMDLETS_LIST } from './PSConstants';

// ─── Interface for device abstraction ─────────────────────────────

export interface PSDeviceContext {
  /**
   * Execute a CMD-level command on the device.
   * PowerShell uses this to delegate native commands (ipconfig, ping, cd, etc.)
   * directly to the CMD interpreter, bypassing the shell-mode router.
   */
  executeCmdCommand(cmd: string): Promise<string>;
  /** Get device hostname */
  getHostname(): string;
  /** Get the virtual file system (for PS-style direct formatting) */
  getFileSystem(): WindowsFileSystem;
  /** Get all ports with their network info */
  getPortsMap(): Map<string, Port>;
  /** Get current working directory */
  getCwd(): string;
  /** Get default gateway IP or null */
  getDefaultGatewayString(): string | null;
  /** This machine's domain-join state, or null while in a workgroup (Get-WmiObject/Get-CimInstance Win32_ComputerSystem's `Domain`). */
  getDomainMembership?(): { dnsName: string } | null;
  /** Resolve a hostname to an IP synchronously (Test-NetConnection). */
  resolveHostnameSync(name: string): IPAddress | null;
  /** Synchronous ICMP probe (Test-NetConnection). */
  sendPingProbeSync(targetIP: IPAddress, opts?: { ttl?: number }): { success: boolean; rttMs: number; ttl: number };
  /** Egress interface/next-hop for a target IP (Test-NetConnection). */
  getEgressFor(targetIP: IPAddress): { sourceIp: IPAddress; interfaceName: string; nextHopIP: IPAddress } | null;
  /** Synchronous TCP reachability probe (Test-NetConnection -Port). */
  tcpProbeSync(targetIP: IPAddress, port: number): boolean;
  /** Get DNS servers for an interface */
  getDnsServers(ifName: string): string[];
  /** Set DNS servers for an interface (optional - for Set-DnsClientServerAddress) */
  setDnsServers?(ifName: string, servers: string[]): void;
  /** Check if interface uses DHCP */
  isDHCPConfigured(ifName: string): boolean;
  /** Get the user manager for access control cmdlets */
  getUserManager(): WindowsUserManager;
  getEnvVars(): Map<string, string>;
  /** Get the service manager for service lifecycle cmdlets */
  getServiceManager(): WindowsServiceManager;
  /** Get the process manager for process management cmdlets */
  getProcessManager(): WindowsProcessManager;
  /**
   * Real network-state primitives (all implemented by WindowsPC/EndHost).
   * The legacy Net* cmdlets MUST use these — never a parallel PS-only
   * store — so cmd and PowerShell always describe the same device state
   * (see AUDIT-COHERENCE-CMD-PS-UX-HELP.md §1).
   */
  configureInterface(ifName: string, ip: IPAddress, mask: SubnetMask, origin?: string): boolean;
  unconfigureInterface(ifName: string): boolean;
  setDefaultGateway(gw: IPAddress): void;
  clearDefaultGateway(): void;
  getRoutingTable(): Array<{ network: IPAddress; mask: SubnetMask; nextHop: IPAddress | null; iface: string; metric: number; type?: string }>;
  addStaticRoute(network: IPAddress, mask: SubnetMask, nextHop: IPAddress, metric?: number): boolean;
  removeRoute(dest: IPAddress, mask: SubnetMask): boolean;
  getSocketTable(): { getAll(): Array<{ protocol: string; localAddress: string; localPort: number; remoteAddress: string; remotePort: number; state: string; pid?: number }> };
  /** Full sync DNS chain: hosts file → resolver cache → servers on the wire. */
  resolveDnsSync(name: string): string[];
  /** Shared scheduled-task store — the same map cmd's schtasks reads/writes. */
  readonly scheduledTasks: Map<string, { taskName: string; taskPath: string; state: string; command?: string; runAt?: Date; intervalMs?: number }>;
  /**
   * Phase 4 relocation: state holders that used to live as private fields
   * on PowerShellExecutor now live on the device. The executor reads/writes
   * through these references; the interpreter providers do too.
   */
  readonly extraIPs:             Map<string, { ifAlias: string; prefixLength: number; prefixOrigin: string; suffixOrigin: string; skipAsSource: boolean; gateway?: string; addressFamily: string }>;
  readonly extraRoutes:          Map<string, { ifAlias: string; nextHop: string; metric: number }>;
  readonly adapterOverrides:     Map<string, { status?: string; displayName?: string }>;
  readonly dynamicFirewallRules: Map<string, { name: string; displayName: string; enabled: boolean; action: string; direction: string; protocol: string; localPort: string; remotePort: string; description: string }>;
  readonly networkProfiles:      Map<number, string>;
  readonly vpnConnections:       Map<string, VpnConnectionInfo>;
  readonly registry:             PSRegistryProvider;
  readonly eventLog:             PSEventLogProvider;
  /** Device id + bus, for handlers that must publish domain events directly. */
  readonly id: string;
  getBus(): IEventBus;
}

// ─── PowerShell Executor ──────────────────────────────────────────

// ─── Structured PS object types (ACL, rule) ──────────────────────

interface PSAclEntry { principal: string; permission: string; ruleType: 'Allow' | 'Deny' }

interface PSAclObj {
  kind: 'acl';
  path: string;
  rules: PSAclEntry[];
  protected: boolean;
}

interface PSRuleObj {
  kind: 'rule';
  principal: string;
  permission: string;
  ruleType: 'Allow' | 'Deny';
}

type PSObjectVar = PSAclObj | PSRuleObj;

export class PowerShellExecutor {
  private cwd: string;
  private device: PSDeviceContext;
  private commandHistory: string[];
  /** Registry hive — relocated to the device (Phase 4). */
  get registry(): PSRegistryProvider { return this.device.registry; }
  /**
   * `$PSVersionTable.OS` build string ("10.0.22631") — read from the same
   * registry values `systeminfo`/`wmic os get caption` already source, so a
   * Windows Server device reports its own build instead of the client's.
   */
  private currentVersionBuild(): string {
    const values = this.registry.getItemPropertyValues('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion');
    const currentVersion = values?.['CurrentVersion'] ?? '10.0';
    const buildNumber = values?.['CurrentBuildNumber'] ?? '22631';
    return `${currentVersion}.${buildNumber}`;
  }
  /** Event log — relocated to the device. */
  get eventLog(): PSEventLogProvider { return this.device.eventLog; }
  /** Session variables: $name → string value */
  private sessionVars: Map<string, string> = new Map();
  /** Session environment overrides (Set-Item Env:X) */
  private sessionEnv: Map<string, string> = new Map();
  /** Structured PS objects (ACL, rule, etc.) keyed by variable name (lowercase) */
  private sessionObjects: Map<string, PSObjectVar> = new Map();
  /** Error log for $Error[n].Exception.Message */
  private errorList: string[] = [];
  /** Defined functions: name → { params, body } */
  private sessionFunctions: Map<string, { params: string[]; body: string }> = new Map();
  /** Additional IP addresses — now lives on the device (Phase 4 relocation).
   *  Kept as a public getter for the rest of this file (which references
   *  this.extraIPs in dozens of places) and for WindowsPSProviders. */
  get extraIPs() { return this.device.extraIPs; }
  /** Extra routes — relocated to the device. */
  get extraRoutes() { return this.device.extraRoutes; }
  /** Location stack for Push-Location/Pop-Location */
  private locationStack: Map<string, string[]> = new Map();
  /** Array variables: $name → string[] */
  private sessionArrays: Map<string, string[]> = new Map();
  /** Variables explicitly assigned as string literals (for += string-concat behaviour) */
  private sessionStringVars: Set<string> = new Set();
  /** Set to true when a `break` statement is executed inside a loop */
  private breakSignal = false;
  /** Set to true when a `continue` statement is executed inside a loop */
  private continueSignal = false;
  /** Adapter overrides — relocated to the device. */
  get adapterOverrides() { return this.device.adapterOverrides; }
  /** Dynamic firewall rules — relocated to the device. */
  get dynamicFirewallRules() { return this.device.dynamicFirewallRules; }
  /** WinHTTP proxy setting (empty = direct access) */
  private winhttpProxy: string = '';
  /** WLAN: currently connected SSID (empty = disconnected) */
  private wlanConnectedSSID: string = '';
  /** WLAN: known profiles (SSIDs) */
  private wlanProfiles: Set<string> = new Set();
  /** Network connection profiles — relocated to the device. */
  get networkProfiles() { return this.device.networkProfiles; }
  /** VPN connections — relocated to the device. */
  get vpnConnections() { return this.device.vpnConnections; }

  constructor(device: PSDeviceContext, initialCwd = 'C:\\Users\\User') {
    this.cwd = initialCwd;
    this.device = device;
    this.commandHistory = [];
    // registry / eventLog now live on the device — no per-executor instances.
  }

  getCwd(): string { return this.cwd; }
  setCwd(cwd: string): void { this.cwd = cwd; }

  getPrompt(): string { return `PS ${this.cwd}> `; }

  setHistory(history: string[]): void { this.commandHistory = history; }
  getHistory(): string[] { return this.commandHistory; }

  /** Public test-path that handles both filesystem and registry paths. Used by PSInterpreter hook. */
  testPathRaw(path: string): boolean {
    if (isRegistryPath(path)) return this.registry.testPath(path);
    const fs = this.device.getFileSystem();
    const absPath = fs.normalizePath(path, this.cwd);
    return fs.exists(absPath);
  }

  /**
   * Execute a PowerShell command line.
   * Returns null for clear-screen commands (caller should handle).
   */
  async execute(cmdline: string): Promise<string | null> {
    const trimmed = cmdline.trim();
    if (!trimmed) return '';

    // Handle semicolon-separated statements (outside of strings/braces)
    const stmts = this.splitStatements(trimmed);
    if (stmts.length > 1) {
      const results: string[] = [];
      for (const stmt of stmts) {
        const r = await this.executeSingleStatement(stmt.trim());
        if (r !== null && r !== '') results.push(r);
      }
      return results.join('\n');
    }

    return this.executeSingleStatement(trimmed);
  }

  private splitStatements(cmdline: string): string[] {
    const parts: string[] = [];
    let cur = '', depth = 0, inSingle = false, inDouble = false;
    for (let i = 0; i < cmdline.length; i++) {
      const ch = cmdline[i];
      if (ch === "'" && !inDouble) { inSingle = !inSingle; cur += ch; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; cur += ch; continue; }
      if (!inSingle && !inDouble) {
        if (ch === '{' || ch === '(') { depth++; cur += ch; continue; }
        if (ch === '}' || ch === ')') { depth--; cur += ch; continue; }
        if ((ch === ';' || ch === '\n') && depth === 0) {
          if (cur.trim()) parts.push(cur.trim()); cur = ''; continue;
        }
      }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts.length ? parts : [cmdline];
  }

  private async executeSingleStatement(trimmed: string): Promise<string | null> {
    // Script block invocation: & { ... } or & { ...; expr }
    const scriptBlockMatch = trimmed.match(/^&\s*\{([\s\S]*)\}$/);
    if (scriptBlockMatch) {
      return this.execute(scriptBlockMatch[1].trim());
    }

    // Script file invocation: & <path.ps1> [args]  or  . <path.ps1> [args]
    //
    // The match is permissive: anything ending in `.ps1` with optional
    // trailing arguments is read from the simulated filesystem and the
    // contents are dispatched through `execute`. Named arguments
    // (`-Foo bar`) are pre-assigned to `$Foo` so `param($Foo)` blocks see
    // their value.
    const scriptInvokeMatch = trimmed.match(
      /^(\.|&)\s+("[^"]+\.ps1"|'[^']+\.ps1'|\S+\.ps1)(\s+.*)?$/i,
    );
    if (scriptInvokeMatch) {
      return this.invokeScriptFile(
        scriptInvokeMatch[2].replace(/^["']|["']$/g, ''),
        (scriptInvokeMatch[3] ?? '').trim(),
      );
    }

    // ── Early returns that must run BEFORE substituteVars ────────────

    // Bare single-quoted string literal — NO variable interpolation
    if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
      return trimmed.slice(1, -1).replace(/''/g, "'");
    }

    // $PSVersionTable.PropertyName — property access on the version table
    const psVtMatch = trimmed.match(/^\$PSVersionTable\.(\w+)$/i);
    if (psVtMatch) {
      const prop = psVtMatch[1].toLowerCase();
      switch (prop) {
        case 'psversion':            return '5.1.19041.4412';
        case 'psedition':            return 'Desktop';
        case 'buildversion':         return '10.0.19041.4412';
        case 'clrversion':           return '4.0.30319.42000';
        case 'wsmanbuildversion':    return '3.0.0.0';
        case 'pscompatibleversions': return '1.0 2.0 3.0 4.0 5.0 5.1.19041.4412';
        case 'platform':             return 'Win32NT';
        case 'os':                   return `Microsoft Windows ${this.currentVersionBuild()}`;
        default:                     return '';
      }
    }

    // return statement (inside function bodies)
    if (/^return\b/i.test(trimmed)) {
      const retExpr = trimmed.slice(6).trim();
      return retExpr ? this.executeSingleStatement(retExpr) : '';
    }

    // Post-increment: $x++ (standalone statement)
    const postIncrMatch = trimmed.match(/^\$(\w+)\s*\+\+$/);
    if (postIncrMatch) {
      const n = postIncrMatch[1].toLowerCase();
      const v = Number(this.sessionVars.get(n) ?? '0') || 0;
      this.sessionVars.set(n, String(v + 1));
      return '';
    }

    // Post-decrement: $x-- (standalone statement)
    const postDecrMatch = trimmed.match(/^\$(\w+)\s*--$/);
    if (postDecrMatch) {
      const n = postDecrMatch[1].toLowerCase();
      const v = Number(this.sessionVars.get(n) ?? '0') || 0;
      this.sessionVars.set(n, String(v - 1));
      return '';
    }

    // Compound assignment: $x += expr  /  -= *= /= %=
    const compoundMatch = trimmed.match(/^\$(\w+)\s*(\+=|-=|\*=|\/=|%=)\s*(.+)$/s);
    if (compoundMatch) {
      const n   = compoundMatch[1].toLowerCase();
      const op  = compoundMatch[2];
      const rhs = this.tryEvalExpr(this.substituteVars(compoundMatch[3].trim())) ?? compoundMatch[3].trim();
      const lhsVal = this.sessionVars.get(n) ?? '';
      let result: string;
      if (op === '+=') {
        const isStrVar = this.sessionStringVars.has(n) || isNaN(Number(lhsVal)) || lhsVal === '';
        result = isStrVar ? lhsVal + rhs : String(Number(lhsVal) + Number(rhs));
      } else {
        const l = Number(lhsVal) || 0, r = Number(rhs) || 0;
        result = String(op === '-=' ? l-r : op === '*=' ? l*r : op === '/=' ? l/r : l%r);
      }
      this.sessionVars.set(n, result);
      return '';
    }

    // Array index access: $arr[n] — before substituteVars erases $arr
    const arrIdxMatch = trimmed.match(/^\$(\w+)\[(-?\d+)\]$/);
    if (arrIdxMatch) {
      const arrName = arrIdxMatch[1].toLowerCase();
      const idx     = parseInt(arrIdxMatch[2], 10);
      const arr     = this.sessionArrays.get(arrName);
      if (arr) {
        const i = idx < 0 ? arr.length + idx : idx;
        return arr[i] ?? '';
      }
      // Handle $Matches[n] from -match operator
      if (arrName === 'matches') {
        const matchesJson = this.sessionVars.get('matches');
        if (matchesJson) {
          try {
            const obj = JSON.parse(matchesJson);
            return String(obj[String(idx)] ?? '');
          } catch { /* ignore */ }
        }
      }
    }

    // $arr.Count / $arr.Length — before substituteVars
    const arrCountMatch = trimmed.match(/^\$(\w+)\.(Count|Length)$/i);
    if (arrCountMatch) {
      const arrName = arrCountMatch[1].toLowerCase();
      const arr = this.sessionArrays.get(arrName);
      if (arr) return String(arr.length);
    }

    // if / elseif / else
    if (/^if\s*\(/i.test(trimmed)) {
      return this.execIfStatement(trimmed);
    }

    // for ($i=0; cond; incr) { body }
    if (/^for\s*\(/i.test(trimmed)) {
      return this.execForLoop(trimmed);
    }

    // foreach ($x in collection) { body }
    if (/^foreach\s*\(/i.test(trimmed)) {
      return this.execForeachLoop(trimmed);
    }

    // while (cond) { body }
    if (/^while\s*\(/i.test(trimmed)) {
      return this.execWhileLoop(trimmed);
    }

    // do { body } while (cond)
    if (/^do\s*\{/i.test(trimmed)) {
      return this.execDoWhileLoop(trimmed);
    }

    // break / continue inside loop bodies
    if (/^break$/i.test(trimmed)) { this.breakSignal = true; return ''; }
    if (/^continue$/i.test(trimmed)) { this.continueSignal = true; return ''; }

    // try/catch block: try { ... } catch { ... }
    const tryCatchMatch = trimmed.match(/^try\s*\{([\s\S]+?)\}\s*catch\s*\{([\s\S]+?)\}$/i);
    if (tryCatchMatch) {
      const tryBody = tryCatchMatch[1].trim();
      const catchBody = tryCatchMatch[2].trim();
      const tryResult = await this.execute(tryBody);
      // Treat any non-empty error-like result (or -ErrorAction Stop) as a terminating error
      const isErrorResult = tryResult && /:\s*(Cannot|Access|not found|does not exist|denied)/i.test(tryResult);
      if (isErrorResult) {
        const errMsg = tryResult ?? '';
        const msgPart = errMsg.replace(/^[\w-]+\s*:\s*/s, '').split('\n')[0];
        this.sessionVars.set('_', msgPart);
        const processedCatch = catchBody
          .replace(/\$\(\$_\.Exception\.Message\)/g, msgPart)
          .replace(/\$_\.Exception\.Message/g, msgPart);
        return this.execute(processedCatch);
      }
      return tryResult;
    }

    // Function definition: function Name { param(...) body }
    //                  or: function Name($a,$b) { body }
    const funcDefMatch = trimmed.match(/^function\s+(\w+)\s*(?:\(([^)]*)\))?\s*\{([\s\S]*)\}$/i);
    if (funcDefMatch) {
      const funcName = funcDefMatch[1].toLowerCase();
      const inlineParamStr = funcDefMatch[2]; // may be undefined
      const body = funcDefMatch[3].trim();
      let params: string[] = [];
      let funcBody = body;
      if (inlineParamStr !== undefined) {
        // function Add($a,$b) { ... } — params in parentheses after name
        params = inlineParamStr.split(',').map(p => p.trim().replace(/^\$|\s*=.*$/g, '').toLowerCase()).filter(Boolean);
      } else {
        // function Greet { param($Name) ... } — params in body
        const paramMatch = body.match(/^param\s*\(([^)]*)\)([\s\S]*)$/i);
        if (paramMatch) {
          params = paramMatch[1].split(',').map(p => p.trim().replace(/^\$|\s*=.*$/g, '').toLowerCase()).filter(Boolean);
          funcBody = paramMatch[2].trim();
        }
      }
      this.sessionFunctions.set(funcName, { params, body: funcBody });
      return '';
    }

    // Method call on object variable: $var.Method(args)
    const methodCallMatch = trimmed.match(/^\$(\w+)\.(\w+)\(([^)]*)\)$/i);
    if (methodCallMatch) {
      const varName = methodCallMatch[1].toLowerCase();
      const method = methodCallMatch[2].toLowerCase();
      const rawArgs = methodCallMatch[3];
      const result = this.handleObjectMethodCall(varName, method, rawArgs);
      if (result !== null) return result;
    }

    // File property setter: (Get-Item path).Prop [+]= value
    const filePropSetMatch = trimmed.match(/^\(Get-Item\s+(.+?)\)\.([\w]+)\s*(\+?=)\s*(.+)$/i);
    if (filePropSetMatch) {
      const itemPath = filePropSetMatch[1].replace(/^["']|["']$/g, '').trim();
      const propName = filePropSetMatch[2].toLowerCase();
      const operator = filePropSetMatch[3];
      const rawValue = filePropSetMatch[4].replace(/^["']|["']$/g, '').trim();
      const fsInst = this.device.getFileSystem();
      const absItemPath = fsInst.normalizePath(itemPath, this.cwd);
      const itemEntry = fsInst.resolve(absItemPath);
      if (itemEntry) {
        if (propName === 'attributes') {
          const attrToAdd = rawValue.toLowerCase();
          if (operator === '+=') {
            itemEntry.attributes.add(attrToAdd);
          } else {
            // = : replace all (keep Directory/Archive as base)
            const preserve = new Set<string>();
            if (itemEntry.type === 'directory') preserve.add('directory');
            itemEntry.attributes = preserve;
            itemEntry.attributes.add(attrToAdd);
          }
        } else if (propName === 'isreadonly') {
          const val = rawValue.toLowerCase();
          if (val === '$true' || val === 'true') itemEntry.attributes.add('readonly');
          else itemEntry.attributes.delete('readonly');
        }
      }
      return '';
    }

    // Variable assignment: $name = expr
    const assignMatch = trimmed.match(/^\$(\w+)\s*=\s*(.+)$/s);
    if (assignMatch) {
      const varName = assignMatch[1].toLowerCase();
      const expr = assignMatch[2].trim();
      // Try to create a structured object
      const obj = this.tryCreateObject(expr);
      if (obj !== null) {
        this.sessionObjects.set(varName, obj);
        this.sessionVars.set(varName, '');
        return '';
      }
      // Handle Get-Acl assignment → create ACL object
      const getAclMatch = expr.match(/^Get-Acl\s+(.+)$/i);
      if (getAclMatch) {
        const path = getAclMatch[1].trim().replace(/^["']|["']$/g, '');
        const fs = this.device.getFileSystem();
        const absPath = fs.normalizePath(path, this.cwd);
        const existingAcl = fs.getACL(absPath);
        const rules: PSAclEntry[] = existingAcl.map(a => ({
          principal: a.principal,
          permission: a.permissions.join(', '),
          ruleType: a.type === 'allow' ? 'Allow' : 'Deny',
        }));
        this.sessionObjects.set(varName, { kind: 'acl', path: absPath, rules, protected: false });
        this.sessionVars.set(varName, '');
        return '';
      }
      // Array literal: @(items) or bare comma-separated items (e.g. 1,2,3)
      const isArrayLiteral = /^@\s*\(/.test(expr) || (/,/.test(expr) && !/\bwhere\b|\bselect\b/i.test(expr) && !expr.includes('|'));
      if (isArrayLiteral) {
        const arr = this.parseArrayLiteral(expr);
        if (arr !== null) {
          this.sessionArrays.set(varName, arr);
          this.sessionStringVars.delete(varName);
          this.sessionVars.set(varName, arr.join(' '));
          return '';
        }
      }
      let value: string;
      if (expr.startsWith('"') && expr.endsWith('"') && expr.length >= 2) {
        value = this.expandDoubleQuotedString(expr.slice(1, -1));
        this.sessionStringVars.add(varName);
      } else if (expr.startsWith("'") && expr.endsWith("'") && expr.length >= 2) {
        value = expr.slice(1, -1).replace(/''/g, "'");
        this.sessionStringVars.add(varName);
      } else {
        this.sessionStringVars.delete(varName);
        const subst = this.substituteVars(expr);
        const evaled = this.tryEvalExpr(subst);
        if (evaled !== null) {
          value = evaled;
        } else {
          const result = await this.executeSingle(subst);
          value = result?.trim() ?? '';
        }
      }
      this.sessionVars.set(varName, value);
      return '';
    }

    // Substitute session variables in the statement
    const substituted = this.substituteVars(trimmed);

    // Check if this is a defined function call (use tokenize to preserve quoted args)
    const words = this.tokenize(substituted.trim());
    const maybeFunc = words[0]?.toLowerCase() ?? '';
    if (this.sessionFunctions.has(maybeFunc)) {
      return this.callSessionFunction(maybeFunc, words.slice(1));
    }

    // Handle pipeline
    if (substituted.includes('|') && !substituted.match(/[>]/)) {
      return this.executePipeline(substituted);
    }
    // Try expression evaluator before falling back to device command dispatch
    const exprResult = this.tryEvalExpr(substituted);
    if (exprResult !== null) return exprResult;
    return this.executeSingle(substituted);
  }

  /** Try to parse a New-Object call into a structured PSObjectVar */
  private tryCreateObject(expr: string): PSObjectVar | null {
    const newObjMatch = expr.match(/^New-Object\s+(.+)$/i);
    if (!newObjMatch) return null;
    const rest = newObjMatch[1].trim();

    // FileSystemAccessRule("principal", "permission", "type")
    const fsArMatch = rest.match(/^System\.Security\.AccessControl\.FileSystemAccessRule\(([^)]+)\)$/i);
    if (fsArMatch) {
      const parts = fsArMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      const principal = parts[0] ?? 'Everyone';
      const permission = parts[1] ?? 'FullControl';
      const ruleType = (parts[2] ?? 'Allow') as 'Allow' | 'Deny';
      return { kind: 'rule', principal, permission, ruleType };
    }

    // FileSecurity (empty ACL)
    if (/^System\.Security\.AccessControl\.FileSecurity$/i.test(rest)) {
      return { kind: 'acl', path: '', rules: [], protected: false };
    }

    return null;
  }

  /** Handle $var.Method(args) for ACL objects */
  private handleObjectMethodCall(varName: string, method: string, rawArgs: string): string | null {
    const obj = this.sessionObjects.get(varName);
    if (!obj) return null;

    if (obj.kind === 'acl') {
      if (method === 'setaccessrule' || method === 'addaccessrule') {
        // Arg is $ruleName → look up the rule object
        const ruleVarName = rawArgs.trim().replace(/^\$/, '').toLowerCase();
        const ruleObj = this.sessionObjects.get(ruleVarName);
        if (ruleObj && ruleObj.kind === 'rule') {
          // Remove existing rule for same principal+type if SetAccessRule
          if (method === 'setaccessrule') {
            obj.rules = obj.rules.filter(
              r => !(r.principal.toLowerCase() === ruleObj.principal.toLowerCase() && r.ruleType === ruleObj.ruleType)
            );
          }
          obj.rules.push({ principal: ruleObj.principal, permission: ruleObj.permission, ruleType: ruleObj.ruleType });
        }
        return '';
      }
      if (method === 'setaccessruleprotection') {
        const argParts = rawArgs.split(',').map(s => s.trim().toLowerCase());
        obj.protected = argParts[0] === '$true' || argParts[0] === 'true';
        return '';
      }
      if (method === 'removeaccessrule') {
        const ruleVarName = rawArgs.trim().replace(/^\$/, '').toLowerCase();
        const ruleObj = this.sessionObjects.get(ruleVarName);
        if (ruleObj && ruleObj.kind === 'rule') {
          obj.rules = obj.rules.filter(r => r.principal.toLowerCase() !== ruleObj.principal.toLowerCase());
        }
        return '';
      }
    }
    return null;
  }

  /** Call a user-defined function with named/positional args */
  private async callSessionFunction(name: string, args: string[]): Promise<string | null> {
    const fn = this.sessionFunctions.get(name);
    if (!fn) return null;

    const savedVars = new Map<string, string>(this.sessionVars);
    const savedArrays = new Map<string, string[]>(this.sessionArrays);

    // Separate named and positional args
    const namedArgs = new Map<string, string>();
    const positionalArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-') && i + 1 < args.length && !args[i + 1]?.startsWith('-')) {
        namedArgs.set(args[i].slice(1).toLowerCase(), args[i + 1].replace(/^["']|["']$/g, ''));
        i++;
      } else if (!args[i].startsWith('-')) {
        positionalArgs.push(args[i].replace(/^["']|["']$/g, ''));
      }
    }

    // Bind named params
    for (const param of fn.params) {
      if (namedArgs.has(param)) this.sessionVars.set(param, namedArgs.get(param)!);
    }
    // Bind positional params (for params not already filled by named args)
    let posIdx = 0;
    for (const param of fn.params) {
      if (!namedArgs.has(param) && posIdx < positionalArgs.length) {
        this.sessionVars.set(param, positionalArgs[posIdx++]);
      }
    }

    const result = await this.execute(fn.body);

    // Restore scope
    this.sessionVars = savedVars;
    this.sessionArrays = savedArrays;

    return result;
  }

  // ─── Expression evaluator ─────────────────────────────────────────

  /** Parse @(...) or bare comma-separated list into string[] */
  private parseArrayLiteral(expr: string): string[] | null {
    let inner = expr.trim();
    if (/^@\s*\(/.test(inner)) {
      const block = this.extractBalancedBlock(inner, inner.indexOf('('), '(');
      if (!block) return null;
      inner = block.content;
    }
    if (!inner.includes(',')) {
      // Single-element array
      const v = inner.trim().replace(/^["']|["']$/g, '');
      return [v];
    }
    return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
  }

  /** Expand $() subexpressions and $var references inside a double-quoted string */
  /**
   * Strip surrounding quotes from a raw argument and apply the
   * appropriate string-expansion semantics:
   *  - "…"  → expandDoubleQuotedString (var interp + backtick escapes)
   *  - '…'  → literal (only doubled-quote `''` → `'`)
   *  - else → returned verbatim.
   */
  private unquoteAndExpand(raw: string): string {
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      return this.expandDoubleQuotedString(raw.slice(1, -1));
    }
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
      return raw.slice(1, -1).replace(/''/g, "'");
    }
    return raw;
  }

  private expandDoubleQuotedString(inner: string): string {
    // PowerShell uses backtick (`) as the escape character inside
    // double-quoted strings. Some sequences (`$ and `") interact with
    // the substitution machinery, so we process them in two passes:
    //
    //   pass 1 — escape protectors:
    //     `$ → \x00D  (literal dollar — do not substitute as a var)
    //     `" → \x00Q  (literal quote)
    //     ``  → \x00B (literal backtick)
    //   pass 2 — variable substitution / sub-expressions (as before)
    //   pass 3 — un-protect + translate the remaining whitespace escapes
    //     `n → "\n", `r → "\r", `t → "\t", `0 → "\0"
    const DOLLAR = '\x00D', QUOTE = '\x00Q', BACK = '\x00B';
    let result = inner
      .replace(/``/g, BACK)
      .replace(/`\$/g, DOLLAR)
      .replace(/`"/g, QUOTE);

    // Expand $($var) or $(expr) subexpressions.
    result = result.replace(/\$\(([^)]*)\)/g, (_match, sub) => {
      const substituted = sub.replace(/\$(\w+)/g, (_m: string, n: string) => {
        const lo = n.toLowerCase();
        if (lo === 'true') return 'True';
        if (lo === 'false') return 'False';
        return this.sessionVars.get(lo) ?? _m;
      });
      return this.tryEvalExpr(substituted) ?? substituted;
    });

    // Expand remaining $var references.
    result = result.replace(/\$(\w+)/g, (_match, n) => {
      const lo = n.toLowerCase();
      if (lo === 'true') return 'True';
      if (lo === 'false') return 'False';
      if (lo === 'null') return '';
      return this.sessionVars.get(lo) ?? _match;
    });

    // Translate the whitespace escape sequences and restore protected chars.
    result = result
      .replace(/`n/g, '\n')
      .replace(/`r/g, '\r')
      .replace(/`t/g, '\t')
      .replace(/`0/g, '\0')
      .replace(new RegExp(DOLLAR, 'g'), '$')
      .replace(new RegExp(QUOTE, 'g'), '"')
      .replace(new RegExp(BACK, 'g'), '`');

    return result;
  }

  /** Return true if the string value is truthy in PowerShell semantics */
  private isTruthy(val: string): boolean {
    const lo = val.trim().toLowerCase();
    return lo !== '' && lo !== 'false' && lo !== '0' && lo !== '$false';
  }

  /**
   * Find the matching close bracket starting from startPos (which must be openChar).
   * Returns content between the brackets and the index of the closing bracket.
   */
  private extractBalancedBlock(str: string, startPos: number, openChar: string): { content: string; end: number } | null {
    const closeChar = openChar === '{' ? '}' : openChar === '(' ? ')' : ']';
    let depth = 0;
    for (let i = startPos; i < str.length; i++) {
      if (str[i] === openChar) depth++;
      else if (str[i] === closeChar) {
        depth--;
        if (depth === 0) return { content: str.slice(startPos + 1, i), end: i };
      }
    }
    return null;
  }

  /**
   * Try to evaluate a PowerShell expression string synchronously.
   * Returns the string result or null if the expression is not recognizable.
   */
  private tryEvalExpr(expr: string): string | null {
    const e = expr.trim();
    if (!e) return null;

    // Boolean / null literals
    if (/^\$true$/i.test(e)) return 'True';
    if (/^\$false$/i.test(e)) return 'False';
    if (/^\$null$/i.test(e)) return '';

    // $env:VARNAME — environment variable lookup (also valid in expression
    // position, e.g. `$env:Path -split ";"`).
    const envExprMatch = e.match(/^\$env:([\w.()-]+)$/i);
    if (envExprMatch) {
      return this.sessionEnv.get(envExprMatch[1].toUpperCase()) ??
        this.resolveEnvVar(envExprMatch[1]) ?? '';
    }

    // Already a number
    if (/^-?\d+(\.\d+)?$/.test(e)) return e;

    // Quoted string literals — only when the opening quote has its matching close at the END
    if (e.startsWith('"') && e.length >= 2) {
      let end = 1;
      while (end < e.length && e[end] !== '"') end++;
      if (end === e.length - 1) return this.expandDoubleQuotedString(e.slice(1, -1));
    }
    if (e.startsWith("'") && e.length >= 2) {
      let end = 1;
      while (end < e.length && e[end] !== "'") end++;
      if (end === e.length - 1) return e.slice(1, -1).replace(/''/g, "'");
    }

    // -not <expr>
    if (/^-not\s+/i.test(e)) {
      const inner = this.tryEvalExpr(e.slice(5).trim());
      if (inner !== null) return this.isTruthy(inner) ? 'False' : 'True';
    }

    // [math]::Method(args)
    const mathMatch = e.match(/^\[math\]::(\w+)\(([^)]*)\)$/i);
    if (mathMatch) {
      const method = mathMatch[1].toLowerCase();
      const argParts = mathMatch[2].split(',').map(a => parseFloat(a.trim()));
      switch (method) {
        case 'pow': return String(Math.pow(argParts[0], argParts[1]));
        case 'round': return String(Math.round(argParts[0]));
        case 'floor': return String(Math.floor(argParts[0]));
        case 'ceiling': return String(Math.ceil(argParts[0]));
        case 'abs': return String(Math.abs(argParts[0]));
        case 'sqrt': return String(Math.sqrt(argParts[0]));
        case 'max': return String(Math.max(argParts[0], argParts[1]));
        case 'min': return String(Math.min(argParts[0], argParts[1]));
        case 'log': return String(argParts.length > 1 ? Math.log(argParts[0]) / Math.log(argParts[1]) : Math.log(argParts[0]));
        case 'truncate': return String(Math.trunc(argParts[0]));
      }
    }

    // [int]::MaxValue / [int]::MinValue / [long]::MaxValue
    const intStaticMatch = e.match(/^\[(int|long|double)\]::(MaxValue|MinValue)$/i);
    if (intStaticMatch) {
      const type = intStaticMatch[1].toLowerCase();
      const prop = intStaticMatch[2].toLowerCase();
      if (type === 'int') return prop === 'maxvalue' ? '2147483647' : '-2147483648';
      if (type === 'long') return prop === 'maxvalue' ? '9223372036854775807' : '-9223372036854775808';
      if (type === 'double') return prop === 'maxvalue' ? '1.7976931348623157E+308' : '5E-324';
    }

    // Type cast: [int]"42"  [string]42  [bool]...
    const castMatch = e.match(/^\[(int|string|bool|double|float|long)\](.+)$/i);
    if (castMatch) {
      const type = castMatch[1].toLowerCase();
      const inner = castMatch[2].trim().replace(/^["']|["']$/g, '');
      if (type === 'int') { const n = parseInt(inner, 10); return isNaN(n) ? '0' : String(n); }
      if (type === 'long') { const n = parseInt(inner, 10); return isNaN(n) ? '0' : String(n); }
      if (type === 'double' || type === 'float') { const n = parseFloat(inner); return isNaN(n) ? '0' : String(n); }
      if (type === 'string') return inner;
      if (type === 'bool') return (inner === '0' || inner.toLowerCase() === 'false' || inner === '') ? 'False' : 'True';
    }

    // Array literal with property: @(1,2,3).Count
    const arrLitPropMatch = e.match(/^(@\([^)]*\))\.(\w+)$/i);
    if (arrLitPropMatch) {
      const arr = this.parseArrayLiteral(arrLitPropMatch[1]);
      if (arr !== null) {
        const prop = arrLitPropMatch[2].toLowerCase();
        if (prop === 'count' || prop === 'length') return String(arr.length);
      }
    }

    // Array concatenation with property: (@(1,2) + @(3,4)).Count
    const arrConcatPropMatch = e.match(/^\((.+)\)\.(\w+)$/);
    if (arrConcatPropMatch) {
      const prop = arrConcatPropMatch[2].toLowerCase();
      if (prop === 'count' || prop === 'length') {
        const inner = arrConcatPropMatch[1].trim();
        const concatMatch = inner.match(/^(@\([^)]*\))\s*\+\s*(@\([^)]*\))$/);
        if (concatMatch) {
          const a = this.parseArrayLiteral(concatMatch[1]);
          const b = this.parseArrayLiteral(concatMatch[2]);
          if (a && b) return String(a.length + b.length);
        }
      }
    }

    // String method calls: "str".Method(args) or "str".Property
    const strMethodMatch = e.match(/^(["'])(.+?)\1\.(\w+)(?:\(([^)]*)\))?$/);
    if (strMethodMatch) {
      const str = strMethodMatch[1] === '"' ? this.expandDoubleQuotedString(strMethodMatch[2]) : strMethodMatch[2].replace(/''/g, "'");
      const method = strMethodMatch[3].toLowerCase();
      const rawArg = strMethodMatch[4] ?? '';
      const arg = rawArg.replace(/^["']|["']$/g, '');
      switch (method) {
        case 'toupper': return str.toUpperCase();
        case 'tolower': return str.toLowerCase();
        case 'trim': return str.trim();
        case 'trimstart': return str.trimStart();
        case 'trimend': return str.trimEnd();
        case 'length': return String(str.length);
        case 'count': return String(str.length);
        case 'contains': return str.includes(arg) ? 'True' : 'False';
        case 'startswith': return str.startsWith(arg) ? 'True' : 'False';
        case 'endswith': return str.endsWith(arg) ? 'True' : 'False';
        case 'indexof': return String(str.indexOf(arg));
        case 'replace': {
          const parts = rawArg.split(',').map(a => a.trim().replace(/^["']|["']$/g, ''));
          return str.split(parts[0]).join(parts[1] ?? '');
        }
        case 'split': {
          const sep = arg || ' ';
          const parts = str.split(sep);
          // Return as a representation — .Count on this is the common usage
          return parts.join('\n');
        }
        case 'substring': {
          const ps = rawArg.split(',').map(a => parseInt(a.trim(), 10));
          return ps.length > 1 ? str.substring(ps[0], ps[0] + ps[1]) : str.substring(ps[0]);
        }
        case 'padleft': return str.padStart(parseInt(arg, 10));
        case 'padright': return str.padEnd(parseInt(arg, 10));
      }
    }

    // Parenthesized expression with .Count/.Length: (expr).Count
    const parenPropMatch = e.match(/^\((.+)\)\.(\w+)(?:\(([^)]*)\))?$/);
    if (parenPropMatch) {
      const innerExpr = parenPropMatch[1].trim();
      const prop = parenPropMatch[2].toLowerCase();
      // Array split: ("hello world".Split(" ")).Count
      if (prop === 'count' || prop === 'length') {
        // -ReadCount 0 or -Raw → whole file is ONE string → Count = 1
        const innerLower = innerExpr.toLowerCase();
        if (/-readcount\s+0(\s|$)/.test(innerLower) || /(^|\s)-raw(\s|$)/.test(innerLower)) return '1';
        const inner = this.tryEvalExpr(innerExpr);
        if (inner !== null) {
          return String(inner.split('\n').filter(Boolean).length || (inner.trim() ? 1 : 0));
        }
      }
    }

    // Parenthesized expression: (expr)
    if (e.startsWith('(') && e.endsWith(')')) {
      const block = this.extractBalancedBlock(e, 0, '(');
      if (block && block.end === e.length - 1) {
        return this.tryEvalExpr(block.content.trim());
      }
    }

    // Binary PS operators — split on the LAST operator to handle nested expressions
    const binOpResult = this.tryEvalBinaryOp(e);
    if (binOpResult !== null) return binOpResult;

    // Pure arithmetic (numbers, operators, parens only)
    return this.evalArithmetic(e);
  }

  /** Try to parse and evaluate a binary PS operator expression */
  private tryEvalBinaryOp(e: string): string | null {
    const ops = ['-and', '-or', '-eq', '-ne', '-ge', '-le', '-gt', '-lt',
                 '-like', '-notlike', '-match', '-notmatch', '-replace',
                 '-split', '-join', '-contains', '-in'];
    // Scan right-to-left to find the last top-level operator (handles left-to-right eval)
    for (const op of ops) {
      const pattern = new RegExp(`^(.+?)\\s+${op.replace('-', '\\-')}\\s+(.+)$`, 'is');
      const m = e.match(pattern);
      if (!m) continue;
      const lhsRaw = m[1].trim();
      const rhsRaw = m[2].trim();
      // Make sure we're at depth 0 (not inside parens/brackets)
      let depth = 0;
      let opIdx = -1;
      const opStr = ` ${op} `;
      const lo = e.toLowerCase();
      let i = 0;
      while (i < lo.length) {
        if (lo[i] === '(' || lo[i] === '{' || lo[i] === '[') { depth++; i++; continue; }
        if (lo[i] === ')' || lo[i] === '}' || lo[i] === ']') { depth--; i++; continue; }
        if (lo[i] === '"') { i++; while (i < lo.length && lo[i] !== '"') i++; i++; continue; }
        if (lo[i] === "'") { i++; while (i < lo.length && lo[i] !== "'") i++; i++; continue; }
        if (depth === 0 && lo.startsWith(op, i) && (i === 0 || lo[i-1] === ' ') && (lo[i + op.length] === ' ' || lo[i + op.length] === undefined)) {
          opIdx = i;
          i += op.length;
          continue;
        }
        i++;
      }
      if (opIdx < 0) continue;
      const lhs = this.tryEvalExpr(e.slice(0, opIdx).trimEnd()) ?? e.slice(0, opIdx).trimEnd();
      const rhs = this.tryEvalExpr(e.slice(opIdx + op.length).trimStart()) ?? e.slice(opIdx + op.length).trimStart();
      return this.applyPSOp(lhs, op, rhs);
    }
    return null;
  }

  /** Apply a PowerShell binary operator to two already-evaluated operands */
  private applyPSOp(lhs: string, op: string, rhs: string): string {
    const lNum = parseFloat(lhs);
    const rNum = parseFloat(rhs);
    const bothNum = !isNaN(lNum) && !isNaN(rNum);
    switch (op.toLowerCase()) {
      case '-eq': return (bothNum ? lNum === rNum : lhs.toLowerCase() === rhs.toLowerCase()) ? 'True' : 'False';
      case '-ne': return (bothNum ? lNum !== rNum : lhs.toLowerCase() !== rhs.toLowerCase()) ? 'True' : 'False';
      case '-gt': return (bothNum && lNum > rNum) ? 'True' : 'False';
      case '-lt': return (bothNum && lNum < rNum) ? 'True' : 'False';
      case '-ge': return (bothNum && lNum >= rNum) ? 'True' : 'False';
      case '-le': return (bothNum && lNum <= rNum) ? 'True' : 'False';
      case '-and': return (this.isTruthy(lhs) && this.isTruthy(rhs)) ? 'True' : 'False';
      case '-or':  return (this.isTruthy(lhs) || this.isTruthy(rhs)) ? 'True' : 'False';
      case '-like': {
        const pattern = '^' + rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
        return new RegExp(pattern, 'i').test(lhs) ? 'True' : 'False';
      }
      case '-notlike': {
        const pattern = '^' + rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
        return new RegExp(pattern, 'i').test(lhs) ? 'False' : 'True';
      }
      case '-match': try {
        const rx = new RegExp(rhs, 'i');
        const m = lhs.match(rx);
        if (m) { this.sessionVars.set('matches', JSON.stringify({ 0: m[0], ...Object.fromEntries(m.slice(1).map((v, i) => [String(i + 1), v ?? ''])) })); }
        return m ? 'True' : 'False';
      } catch { return 'False'; }
      case '-notmatch': try { return new RegExp(rhs, 'i').test(lhs) ? 'False' : 'True'; } catch { return 'True'; }
      case '-replace': {
        // rhs may be "pattern","replacement" or just "pattern"
        const comma = rhs.lastIndexOf(',');
        const [pat, repl] = comma > 0
          ? [rhs.slice(0, comma).trim().replace(/^["']|["']$/g, ''), rhs.slice(comma + 1).trim().replace(/^["']|["']$/g, '')]
          : [rhs.replace(/^["']|["']$/g, ''), ''];
        try { return lhs.replace(new RegExp(pat, 'gi'), repl); } catch { return lhs; }
      }
      case '-split': {
        // rhs is the separator (regex by default in real PS; we treat it
        // as a literal string for simplicity). Drop surrounding quotes.
        const sep = rhs.replace(/^["']|["']$/g, '');
        if (!sep) return lhs;
        return lhs.split(sep).join('\n');
      }
      case '-join': {
        const sep = rhs.replace(/^["']|["']$/g, '');
        // lhs is the array-as-string (newline-joined). Re-join with sep.
        return lhs.split('\n').filter((x) => x !== '').join(sep);
      }
      case '-contains': return lhs.toLowerCase().includes(rhs.toLowerCase()) ? 'True' : 'False';
      case '-in': return rhs.toLowerCase().includes(lhs.toLowerCase()) ? 'True' : 'False';
      default: return 'False';
    }
  }

  /**
   * Evaluate a pure arithmetic expression (numbers + - * / % and parentheses).
   * Returns the numeric result as a string, or null if the expression contains
   * anything that is not a number/operator/paren.
   */
  private evalArithmetic(expr: string): string | null {
    type Token = { t: 'num'; v: number } | { t: 'op'; v: string } | { t: 'lp' } | { t: 'rp' };
    const tokens: Token[] = [];
    let i = 0;
    const e = expr.trim();
    while (i < e.length) {
      if (/\s/.test(e[i])) { i++; continue; }
      if (/\d/.test(e[i]) || (e[i] === '.' && /\d/.test(e[i + 1] ?? ''))) {
        let num = '';
        while (i < e.length && (/\d/.test(e[i]) || e[i] === '.')) num += e[i++];
        tokens.push({ t: 'num', v: parseFloat(num) });
      } else if (e[i] === '(') { tokens.push({ t: 'lp' }); i++; }
      else if (e[i] === ')') { tokens.push({ t: 'rp' }); i++; }
      else if (['+', '-', '*', '/', '%'].includes(e[i])) {
        tokens.push({ t: 'op', v: e[i] }); i++;
      } else {
        return null; // non-arithmetic character
      }
    }
    if (tokens.length === 0) return null;

    let pos = 0;
    const peek = () => tokens[pos];
    const consume = () => tokens[pos++];

    function prec(op: string) { return (op === '+' || op === '-') ? 1 : 2; }

    function parseE(minP: number): number | null {
      let lhs = parsePrimary();
      if (lhs === null) return null;
      while (peek()?.t === 'op') {
        const p = prec((peek() as { t: 'op'; v: string }).v);
        if (p < minP) break;
        const op = (consume() as { t: 'op'; v: string }).v;
        const rhs = parseE(p + 1);
        if (rhs === null) return null;
        lhs = op === '+' ? lhs + rhs : op === '-' ? lhs - rhs : op === '*' ? lhs * rhs :
              op === '/' ? (rhs !== 0 ? lhs / rhs : NaN) : lhs % rhs;
      }
      return lhs;
    }

    function parsePrimary(): number | null {
      const tok = peek();
      if (!tok) return null;
      if (tok.t === 'num') { consume(); return tok.v; }
      if (tok.t === 'op' && tok.v === '-') { consume(); const v = parsePrimary(); return v !== null ? -v : null; }
      if (tok.t === 'lp') {
        consume();
        const v = parseE(1);
        if (peek()?.t === 'rp') consume();
        return v;
      }
      return null;
    }

    const result = parseE(1);
    if (result === null || pos !== tokens.length) return null;
    if (isNaN(result)) return null;
    return Number.isInteger(result) ? String(result) : String(result);
  }

  // ─── Control flow methods ─────────────────────────────────────────

  /** Execute an if/elseif/else chain */
  private async execIfStatement(trimmed: string): Promise<string> {
    let pos = 2; // skip 'if'
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;

    const condBlock = this.extractBalancedBlock(trimmed, pos, '(');
    if (!condBlock) return '';
    pos = condBlock.end + 1;
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;

    const bodyBlock = this.extractBalancedBlock(trimmed, pos, '{');
    if (!bodyBlock) return '';
    pos = bodyBlock.end + 1;

    const condVal = this.tryEvalExpr(this.substituteVars(condBlock.content)) ?? condBlock.content;
    if (this.isTruthy(condVal)) return (await this.execute(bodyBlock.content)) ?? '';

    // elseif / else branches
    while (pos < trimmed.length) {
      while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;
      const rest = trimmed.slice(pos);
      if (/^elseif\s*\(/i.test(rest)) {
        const kw = rest.match(/^elseif\s*/i)![0];
        pos += kw.length;
        const eiCond = this.extractBalancedBlock(trimmed, pos, '(');
        if (!eiCond) break;
        pos = eiCond.end + 1;
        while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;
        const eiBody = this.extractBalancedBlock(trimmed, pos, '{');
        if (!eiBody) break;
        pos = eiBody.end + 1;
        const eiVal = this.tryEvalExpr(this.substituteVars(eiCond.content)) ?? eiCond.content;
        if (this.isTruthy(eiVal)) return (await this.execute(eiBody.content)) ?? '';
      } else if (/^else\s*\{/i.test(rest)) {
        const kw = rest.match(/^else\s*/i)![0];
        pos += kw.length;
        const elseBody = this.extractBalancedBlock(trimmed, pos, '{');
        if (!elseBody) break;
        return (await this.execute(elseBody.content)) ?? '';
      } else {
        break;
      }
    }
    return '';
  }

  /** Execute a for ($i=init; cond; incr) { body } loop */
  private async execForLoop(trimmed: string): Promise<string> {
    let pos = 3; // skip 'for'
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;

    const headerBlock = this.extractBalancedBlock(trimmed, pos, '(');
    if (!headerBlock) return '';
    pos = headerBlock.end + 1;
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;

    const bodyBlock = this.extractBalancedBlock(trimmed, pos, '{');
    if (!bodyBlock) return '';

    // Split header by semicolons (respects nested parens via splitStatements)
    const hParts = this.splitStatements(headerBlock.content);
    if (hParts.length < 3) return '';
    const [initPart, condPart, incrPart] = hParts;

    await this.executeSingleStatement(initPart.trim());

    const outputs: string[] = [];
    let iter = 0;
    while (iter++ < 10000) {
      const condVal = this.tryEvalExpr(this.substituteVars(condPart.trim())) ?? 'False';
      if (!this.isTruthy(condVal)) break;

      const bodyResult = await this.execute(bodyBlock.content);
      if (this.breakSignal) { this.breakSignal = false; break; }
      if (this.continueSignal) { this.continueSignal = false; }
      else if (bodyResult) outputs.push(bodyResult);

      await this.executeSingleStatement(incrPart.trim());
    }
    return outputs.filter(Boolean).join('\n');
  }

  /** Execute a foreach ($x in collection) { body } loop */
  private async execForeachLoop(trimmed: string): Promise<string> {
    let pos = 7; // skip 'foreach'
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;

    const headerBlock = this.extractBalancedBlock(trimmed, pos, '(');
    if (!headerBlock) return '';
    pos = headerBlock.end + 1;
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;

    const bodyBlock = this.extractBalancedBlock(trimmed, pos, '{');
    if (!bodyBlock) return '';

    // Parse header: $varName in <collection>
    const headerMatch = headerBlock.content.match(/^\$(\w+)\s+in\s+(.+)$/is);
    if (!headerMatch) return '';
    const loopVar = headerMatch[1].toLowerCase();
    const collExpr = headerMatch[2].trim();

    // Resolve collection
    let items: string[];
    const arrVarName = collExpr.match(/^\$(\w+)$/)?.[1]?.toLowerCase();
    if (arrVarName && this.sessionArrays.has(arrVarName)) {
      items = this.sessionArrays.get(arrVarName)!;
    } else {
      const subst = this.substituteVars(collExpr);
      // Comma-separated literal values (e.g. "1,2,3" or "a","b","c")
      if (/,/.test(subst) && !subst.includes('|')) {
        items = subst.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      } else {
        const res = await this.execute(subst);
        items = res ? res.split('\n').filter(Boolean) : [];
      }
    }

    const outputs: string[] = [];
    for (const item of items) {
      this.sessionVars.set(loopVar, item);
      const bodyResult = await this.execute(bodyBlock.content);
      if (this.breakSignal) { this.breakSignal = false; break; }
      if (this.continueSignal) { this.continueSignal = false; continue; }
      if (bodyResult) outputs.push(bodyResult);
    }
    return outputs.filter(Boolean).join('\n');
  }

  /** Execute a while (cond) { body } loop */
  private async execWhileLoop(trimmed: string): Promise<string> {
    let pos = 5; // skip 'while'
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;

    const condBlock = this.extractBalancedBlock(trimmed, pos, '(');
    if (!condBlock) return '';
    pos = condBlock.end + 1;
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;

    const bodyBlock = this.extractBalancedBlock(trimmed, pos, '{');
    if (!bodyBlock) return '';

    const outputs: string[] = [];
    let iter = 0;
    while (iter++ < 10000) {
      const condVal = this.tryEvalExpr(this.substituteVars(condBlock.content)) ?? 'False';
      if (!this.isTruthy(condVal)) break;

      const bodyResult = await this.execute(bodyBlock.content);
      if (this.breakSignal) { this.breakSignal = false; break; }
      if (this.continueSignal) { this.continueSignal = false; continue; }
      if (bodyResult) outputs.push(bodyResult);
    }
    return outputs.filter(Boolean).join('\n');
  }

  /** Execute a do { body } while (cond) loop */
  private async execDoWhileLoop(trimmed: string): Promise<string> {
    let pos = 2; // skip 'do'
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;

    const bodyBlock = this.extractBalancedBlock(trimmed, pos, '{');
    if (!bodyBlock) return '';
    pos = bodyBlock.end + 1;
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;

    // Expect 'while'
    const rest = trimmed.slice(pos);
    const wMatch = rest.match(/^while\s*/i);
    if (!wMatch) return '';
    pos += wMatch[0].length;

    const condBlock = this.extractBalancedBlock(trimmed, pos, '(');
    if (!condBlock) return '';

    const outputs: string[] = [];
    let iter = 0;
    do {
      const bodyResult = await this.execute(bodyBlock.content);
      if (this.breakSignal) { this.breakSignal = false; break; }
      if (this.continueSignal) { this.continueSignal = false; }
      else if (bodyResult) outputs.push(bodyResult);
      const condVal = this.tryEvalExpr(this.substituteVars(condBlock.content)) ?? 'False';
      if (!this.isTruthy(condVal)) break;
    } while (iter++ < 10000);
    return outputs.filter(Boolean).join('\n');
  }

  /** Replace $varName with stored session variable values */
  private substituteVars(cmdline: string): string {
    return cmdline.replace(/\$\((\$\w+)\)/g, (_, inner) => {
      const name = inner.slice(1).toLowerCase();
      return this.sessionVars.get(name) ?? inner;
    }).replace(/(`?)\$(\w+)/g, (match, escape, name) => {
      // ` before $ escapes it (PS double-quoted-string semantics). Keep
      // the literal `$Name so expandDoubleQuotedString can convert it
      // back later.
      if (escape === '`') return match;
      const lower = name.toLowerCase();
      // Don't substitute reserved variables — handled by executeSingle
      if (['psversiontable','host','pwd','true','false','null','pid','_'].includes(lower)) return match;
      if (lower.startsWith('env:')) return match;
      if (lower.startsWith('error')) return match;
      // Don't substitute object variables — they're referenced by name in cmdlet args
      if (this.sessionObjects.has(lower)) return match;
      return this.sessionVars.get(lower) ?? match;
    });
  }

  // ─── Pipeline handling ──────────────────────────────────────────

  private async executePipeline(cmdline: string): Promise<string | null> {
    // Unwrap a single outer pair of parentheses: `(expr | filter)` is the
    // sub-expression form — we evaluate the inner pipeline normally and
    // return its output to the host.
    const t = cmdline.trim();
    if (t.startsWith('(') && t.endsWith(')')) {
      const block = this.extractBalancedBlock(t, 0, '(');
      if (block && block.end === t.length - 1) {
        return this.executePipeline(block.content.trim());
      }
    }
    const parts = this.splitPipeline(cmdline);
    if (parts.length < 2) return this.executeSingle(cmdline);

    // Process pipeline stages left-to-right so intermediate transformations compose correctly
    let currentOutput: PipelineInput = await this.executeForPipeline(parts[0]);

    for (let i = 1; i < parts.length; i++) {
      const filter = parts[i].trim();
      const filterCmdLower = filter.split(/\s+/)[0].toLowerCase();

      // ForEach-Object -MemberName: `% PropName` (no scriptblock) — extracts scalar property value
      const memberNameMatch = filter.match(/^(?:foreach-object|foreach|%)\s+(\w+)$/i);
      if (memberNameMatch) {
        const memberName = memberNameMatch[1];
        if (Array.isArray(currentOutput)) {
          const objs = currentOutput as import('./PSPipeline').PSObject[];
          const values = objs.map(obj => {
            const key = Object.keys(obj).find(k => k.toLowerCase() === memberName.toLowerCase());
            return key !== undefined ? String(obj[key] ?? '') : '';
          }).filter(Boolean);
          currentOutput = values.join('\n');
        } else {
          const parsed = parseTable(String(currentOutput)) ?? parseKeyValueBlocks(String(currentOutput));
          if (parsed && parsed.length > 0) {
            const values = parsed.map(obj => {
              const key = Object.keys(obj).find(k => k.toLowerCase() === memberName.toLowerCase());
              return key !== undefined ? String(obj[key] ?? '') : '';
            }).filter(Boolean);
            currentOutput = values.join('\n');
          }
        }
        continue;
      }

      // ForEach-Object with PS scriptblock
      const foreachMatch = filter.match(/^(?:foreach-object|foreach|%)\s*\{\s*([\s\S]+?)\s*\}$/i);
      if (foreachMatch) {
        const scriptBody = foreachMatch[1].trim();
        // Simple $_.Property accessor on PSObjects → delegate to PSPipeline for correct property lookup
        const propAccessMatch = Array.isArray(currentOutput) && scriptBody.match(/^\$_\.(\w+)$/i);
        if (propAccessMatch) {
          currentOutput = runPipeline(currentOutput as PipelineInput, [filter]);
          continue;
        }
        // PSObject array: substitute $_.PropName using object properties
        if (Array.isArray(currentOutput) && currentOutput.length > 0) {
          const objs = currentOutput as import('./PSPipeline').PSObject[];
          const results: string[] = [];
          for (const obj of objs) {
            let cmd = scriptBody;
            const itemValue = () => {
              const nameKey = Object.keys(obj).find(k => k.toLowerCase() === 'name');
              if (nameKey) return String(obj[nameKey] ?? '');
              const firstKey = Object.keys(obj)[0];
              return firstKey ? String(obj[firstKey] ?? '') : '';
            };
            // Special case: scriptBody is exactly `$_.METHOD(args)` — evaluate
            // as a method call on the current item value.
            const methodOnlyMatch = scriptBody.match(/^\$_\.(\w+)\(([^)]*)\)$/);
            if (methodOnlyMatch) {
              const val = itemValue().replace(/"/g, '`"');
              const evaled = this.tryEvalExpr(`"${val}".${methodOnlyMatch[1]}(${methodOnlyMatch[2]})`);
              if (evaled !== null) {
                results.push(evaled);
                continue;
              }
            }
            // Replace $_.METHOD(args) → evaluate as method call on the current item's value
            cmd = cmd.replace(/\$_\.(\w+)\(([^)]*)\)/g, (full, method, methodArgs) => {
              const val = itemValue().replace(/"/g, '`"');
              const evaled = this.tryEvalExpr(`"${val}".${method}(${methodArgs})`);
              return evaled !== null ? evaled : full;
            });
            // Replace $_.PropName ONLY when the property actually exists on the object
            // (otherwise $_.txt would incorrectly eat ".txt" as a property name)
            cmd = cmd.replace(/\$_\.(\w+)/g, (full, prop) => {
              const key = Object.keys(obj).find(k => k.toLowerCase() === prop.toLowerCase());
              return key !== undefined ? String(obj[key] ?? '') : full;
            });
            // Replace bare $_ (or $_ immediately before non-word chars like . " etc.)
            cmd = cmd.replace(/\$_(?=\W|$)/g, () => itemValue());
            const trimmedCmd = cmd.trim();
            // Try arithmetic / expression evaluator first; fall back to command dispatch
            const exprVal = this.tryEvalExpr(trimmedCmd);
            const result = exprVal !== null ? exprVal : await this.executeSingle(trimmedCmd);
            if (result !== null && result !== '') results.push(result);
          }
          currentOutput = results.join('\n');
          continue;
        }
        // Complex scriptblock: text-based substitution on string lines
        const items = this.pipelineToLines(currentOutput);
        const results: string[] = [];
        for (const item of items) {
          const cmd = scriptBody
            .replace(/\$\(\$_\)/g, item)
            .replace(/\$_(?=\W|$)/g, item);
          const trimmedCmd = cmd.trim();
          const exprVal = this.tryEvalExpr(trimmedCmd);
          const result = exprVal !== null ? exprVal : await this.executeSingle(trimmedCmd);
          if (result !== null && result !== '') results.push(result);
        }
        currentOutput = results.join('\n');
        continue;
      }

      // Clear-Host as pipeline sink — discards input, clears screen
      if (filterCmdLower === 'clear-host' || filterCmdLower === 'cls' || filterCmdLower === 'clear') {
        return '';
      }

      // Set-Content as pipeline sink — terminates the pipeline
      if (filterCmdLower === 'set-content') {
        const sinkArgs = this.tokenize(filter).slice(1);
        const content = this.pipelineToContent(currentOutput);
        return this.handleSetContentWithPiped(sinkArgs, content);
      }

      // Service action cmdlets accepting pipeline input
      if (filterCmdLower === 'start-service' || filterCmdLower === 'sasv' ||
          filterCmdLower === 'stop-service' || filterCmdLower === 'spsv' ||
          filterCmdLower === 'restart-service') {
        const filterTokens = this.tokenize(filter);
        const filterArgs = filterTokens.slice(1);
        const hasWhatIf = filterArgs.some(a => a.toLowerCase() === '-whatif');

        // Extract service name from pipeline input
        let svcName = '';
        if (Array.isArray(currentOutput)) {
          const objs = currentOutput as import('./PSPipeline').PSObject[];
          if (objs.length > 0) svcName = String(objs[0]['Name'] ?? '');
        } else {
          const kvMatch = String(currentOutput).match(/^Name\s*:\s*(.+)$/im);
          if (kvMatch) svcName = kvMatch[1].trim();
        }

        if (hasWhatIf) {
          const actionName = filterCmdLower === 'start-service' ? 'Start-Service'
            : filterCmdLower === 'stop-service' ? 'Stop-Service' : 'Restart-Service';
          const svc = svcName ? this.device.getServiceManager().getService(svcName) : null;
          const target = svc ? `${svc.displayName} (${svc.name})` : svcName;
          return `What if: Performing the operation "${actionName}" on target "${target}".`;
        }

        if (svcName) {
          const svcArgs = [...filterArgs, '-Name', svcName];
          const svcCtx = this.buildPSServiceCtx();
          if (filterCmdLower === 'start-service' || filterCmdLower === 'sasv') {
            currentOutput = psStartService(svcCtx, svcArgs);
          } else if (filterCmdLower === 'stop-service' || filterCmdLower === 'spsv') {
            currentOutput = psStopService(svcCtx, svcArgs);
          } else {
            currentOutput = psRestartService(svcCtx, svcArgs);
          }
        }
        continue;
      }

      // Stop-Process pipeline sink
      if (filterCmdLower === 'stop-process' || filterCmdLower === 'kill') {
        const filterTokens = this.tokenize(filter);
        const filterArgs = filterTokens.slice(1);
        const hasWhatIf = filterArgs.some(a => a.toLowerCase() === '-whatif');

        // Extract process name or id from pipeline input
        let procName = '';
        let procId = '';
        if (Array.isArray(currentOutput)) {
          const objs = currentOutput as import('./PSPipeline').PSObject[];
          if (objs.length > 0) {
            procName = String(objs[0]['Name'] ?? objs[0]['ProcessName'] ?? '');
            procId = String(objs[0]['Id'] ?? objs[0]['PID'] ?? '');
          }
        } else {
          const kvName = String(currentOutput).match(/^(?:Name|ProcessName)\s*:\s*(.+)$/im);
          const kvId = String(currentOutput).match(/^(?:Id|PID)\s*:\s*(.+)$/im);
          if (kvName) procName = kvName[1].trim();
          if (kvId) procId = kvId[1].trim();
        }

        if (hasWhatIf && (procName || procId)) {
          return `What if: Performing the operation "Stop-Process" on target "${procName || procId}".`;
        }

        if (procName || procId) {
          const procArgs = [...filterArgs];
          if (procName) procArgs.push('-Name', procName);
          else procArgs.push('-Id', procId);
          currentOutput = psStopProcess(this.buildPSProcessCtx(), procArgs);
        }
        continue;
      }

      // Get-ChildItem accepting pipeline input (path from previous stage)
      if (filterCmdLower === 'get-childitem' || filterCmdLower === 'gci' || filterCmdLower === 'ls' || filterCmdLower === 'dir') {
        const filterArgs = this.tokenize(filter).slice(1);
        const pipedPath = this.extractFullPathFromPipelineOutput(currentOutput);
        currentOutput = this.handleGetChildItem(filterArgs, pipedPath || undefined);
        continue;
      }

      // Move-Item accepting pipeline input
      if (filterCmdLower === 'move-item' || filterCmdLower === 'mv' || filterCmdLower === 'move') {
        const filterArgs = this.tokenize(filter).slice(1);
        const pipedPath = this.extractFullPathFromPipelineOutput(currentOutput);
        if (pipedPath) {
          const allArgs = [...filterArgs];
          // Only skip prepending if an explicit -Path/-LiteralPath is already present
          if (!allArgs.some(a => a.toLowerCase() === '-path' || a.toLowerCase() === '-literalpath')) {
            allArgs.unshift(pipedPath);
          }
          currentOutput = this.handleMoveItem(allArgs);
        }
        continue;
      }

      // Rename-Item accepting pipeline input
      if (filterCmdLower === 'rename-item' || filterCmdLower === 'rni' || filterCmdLower === 'ren') {
        const filterArgs = this.tokenize(filter).slice(1);
        const pipedPath = this.extractFullPathFromPipelineOutput(currentOutput);
        if (pipedPath) {
          const allArgs = [pipedPath, ...filterArgs];
          currentOutput = this.handleRenameItem(allArgs);
        }
        continue;
      }

      // Copy-Item accepting pipeline input
      if (filterCmdLower === 'copy-item' || filterCmdLower === 'cp' || filterCmdLower === 'copy') {
        const filterArgs = this.tokenize(filter).slice(1);
        const hasWhatIf = filterArgs.some(a => a.toLowerCase() === '-whatif');
        const pipedPath = this.extractFullPathFromPipelineOutput(currentOutput);
        if (hasWhatIf && pipedPath) {
          const destArg = filterArgs.find(a => !a.startsWith('-')) ?? '';
          currentOutput = `What if: Performing the operation "Copy File" on target "Item: ${pipedPath} Destination: ${destArg}".`;
          continue;
        }
        if (pipedPath) {
          const allArgs = [pipedPath, ...filterArgs.filter(a => a.toLowerCase() !== '-whatif')];
          currentOutput = this.handleCopyItem(allArgs);
        }
        continue;
      }

      // Remove-NetIPAddress accepting pipeline input
      if (filterCmdLower === 'remove-netipaddress') {
        const filterArgs = this.tokenize(filter).slice(1);
        let pipedIP = '';
        if (Array.isArray(currentOutput)) {
          const objs = currentOutput as import('./PSPipeline').PSObject[];
          if (objs.length > 0) pipedIP = String(objs[0]['IPAddress'] ?? '');
        } else {
          const kvMatch = String(currentOutput).match(/^IPAddress\s*:\s*(.+)$/im);
          if (kvMatch) pipedIP = kvMatch[1].trim();
        }
        if (pipedIP) {
          const allArgs = [...filterArgs, '-IPAddress', pipedIP];
          currentOutput = await this.executeSingle(['remove-netipaddress', ...allArgs].join(' ')) ?? '';
        }
        continue;
      }

      // Set-NetIPAddress accepting pipeline input
      if (filterCmdLower === 'set-netipaddress') {
        const filterArgs = this.tokenize(filter).slice(1);
        let pipedIP = '';
        if (Array.isArray(currentOutput)) {
          const objs = currentOutput as import('./PSPipeline').PSObject[];
          if (objs.length > 0) pipedIP = String(objs[0]['IPAddress'] ?? '');
        } else {
          const kvMatch = String(currentOutput).match(/^IPAddress\s*:\s*(.+)$/im);
          if (kvMatch) pipedIP = kvMatch[1].trim();
        }
        if (pipedIP) {
          const allArgs = [...filterArgs, '-IPAddress', pipedIP];
          currentOutput = await this.executeSingle(['set-netipaddress', ...allArgs].join(' ')) ?? '';
        }
        continue;
      }

      // Generic -WhatIf sink for storage/user cmdlets (Initialize-Disk, Format-Volume, Disable-LocalUser, Enable-LocalUser, etc.)
      if (filter.toLowerCase().includes('-whatif')) {
        const [sinkCmd] = this.tokenize(filter);
        const actionMap: Record<string, string> = {
          'initialize-disk': 'Initialize-Disk',
          'format-volume': 'Format-Volume',
          'disable-localuser': 'Disable-LocalUser',
          'enable-localuser': 'Enable-LocalUser',
          'disable-netadapter': 'Disable-NetAdapter',
        };
        const actionName = actionMap[sinkCmd.toLowerCase()] ?? sinkCmd;
        // Extract a target identifier from pipeline input
        let target = '';
        if (Array.isArray(currentOutput)) {
          const objs = currentOutput as import('./PSPipeline').PSObject[];
          if (objs.length > 0) {
            const firstObj = objs[0];
            target = String(firstObj['Name'] ?? firstObj['Number'] ?? firstObj['DriveLetter'] ?? firstObj['FriendlyName'] ?? '');
          }
        } else {
          const kvAny = String(currentOutput).match(/^(?:Name|Number|DriveLetter|FriendlyName)\s*:\s*(.+)$/im);
          if (kvAny) target = kvAny[1].trim();
        }
        return `What if: Performing the operation "${actionName}" on target "${target}".`;
      }

      // findstr / find — CMD-style line grep, must run on raw string
      if (filterCmdLower === 'findstr' || filterCmdLower === 'find') {
        const rawStr = typeof currentOutput === 'string'
          ? currentOutput
          : (runPipeline(currentOutput as PipelineInput, []) ?? '');
        const patternRaw = filter.split(/\s+/).slice(1).join(' ').replace(/^["']|["']$/g, '').replace(/\s+\/[a-zA-Z]+/g, '').trim();
        const lines = rawStr.split('\n');
        currentOutput = lines.filter(l => l.toLowerCase().includes(patternRaw.toLowerCase())).join('\n');
        continue;
      }

      // Other filters (Select-Object, Where-Object, Format-*, etc.) — use PSPipeline
      currentOutput = runPipeline(currentOutput, [filter]);
    }

    if (typeof currentOutput === 'string') return currentOutput || null;
    return runPipeline(currentOutput as PipelineInput, []) || null;
  }

  private pipelineToLines(input: PipelineInput): string[] {
    if (typeof input === 'string') {
      return input.split('\n').filter(l => l.trim());
    }
    return (input as PSObject[]).map(o => {
      const key = Object.keys(o)[0];
      return key ? String(o[key] ?? '') : '';
    }).filter(s => s !== '');
  }

  private pipelineToContent(input: PipelineInput): string {
    if (typeof input === 'string') return input;
    return (input as PSObject[]).map(o => {
      const key = Object.keys(o)[0];
      return key ? String(o[key] ?? '') : '';
    }).join('\n');
  }

  private handleSetContentWithPiped(args: string[], content: string): string {
    const fs = this.device.getFileSystem();
    let path = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
    }
    if (!path) return '';
    const absPath = fs.normalizePath(path, this.cwd);
    fs.createFile(absPath, content);
    return '';
  }

  /**
   * Split a pipeline string by | while respecting quotes and braces.
   */
  private splitPipeline(cmdline: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuote: string | null = null;
    let braceDepth = 0;
    let parenDepth = 0;

    for (const ch of cmdline) {
      if (inQuote) {
        current += ch;
        if (ch === inQuote) inQuote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inQuote = ch; current += ch; continue; }
      if (ch === '{') { braceDepth++; current += ch; continue; }
      if (ch === '}') { braceDepth--; current += ch; continue; }
      if (ch === '(') { parenDepth++; current += ch; continue; }
      if (ch === ')') { parenDepth--; current += ch; continue; }
      if (ch === '|' && braceDepth === 0 && parenDepth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  /**
   * Extract a full filesystem path from pipeline output (GCI or Get-Item table).
   * The GCI table format has fixed columns: mode(20) + ' ' + date(20) + ' ' + size(14) + ' ' + name
   * Name starts at column index 57 of the data row.
   * Priority: FullName K:V > PSObject FullName > GCI table parsing.
   */
  private extractFullPathFromPipelineOutput(output: PipelineInput): string {
    // PSObject array: use FullName or Name property
    if (Array.isArray(output)) {
      const objs = output as import('./PSPipeline').PSObject[];
      if (objs.length > 0) {
        const fullName = objs[0]['FullName'] ?? objs[0]['fullName'];
        if (fullName) return String(fullName);
        const name = objs[0]['Name'] ?? objs[0]['name'];
        if (name) return String(name);
      }
      return '';
    }
    const str = String(output);
    // K:V FullName property (added by enhanced Get-Item / GCI)
    const kvFullName = str.match(/^FullName\s*:\s*(.+)$/im);
    if (kvFullName) return kvFullName[1].trim();
    // K:V Path property
    const kvPath = str.match(/^(?:Path|FullPath)\s*:\s*(.+)$/im);
    if (kvPath) return kvPath[1].trim();
    // GCI table: parse Directory line + name at column 57
    const dirMatch = str.match(/Directory:\s+(.+)/i);
    if (dirMatch) {
      const parentRaw = dirMatch[1].trim();
      // Name at fixed column 57 in each data row (mode padded to 20 + space + date 20 + space + size 14 + space)
      const dataLine = str.split('\n').find(l => /^[-d][-a][-r][-h][-s][-l]/.test(l));
      if (dataLine) {
        const name = dataLine.length > 57 ? dataLine.substring(57).trim() : dataLine.trim().split(/\s+/).pop() ?? '';
        if (name) {
          const parent = parentRaw.endsWith('\\') ? parentRaw : parentRaw + '\\';
          return parent + name;
        }
      }
    }
    return '';
  }

  /**
   * Execute a single command and return structured output (PSObject[])
   * when possible, for proper pipeline processing.
   */
  private tryParseArrayLiteral(expr: string): string[] | null {
    if (!expr.includes(',')) return null;
    const parts: string[] = [];
    let cur = '', inSingle = false, inDouble = false;
    for (const ch of expr) {
      if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
      if (ch === ',' && !inSingle && !inDouble) {
        const t = cur.trim();
        if (!t) return null;
        parts.push(t);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) parts.push(cur.trim());
    if (parts.length < 2) return null;
    // Each part must be a simple value (no spaces, looks like a literal)
    for (const p of parts) {
      if (p.includes(' ') || p.startsWith('-')) return null;
    }
    return parts;
  }

  private async executeForPipeline(cmd: string): Promise<PipelineInput> {
    const trimmedCmd = cmd.trim();

    // Range expression: 1..5 → ['1','2','3','4','5']
    const rangeMatch = trimmedCmd.match(/^(-?\d+)\.\.(-?\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end   = parseInt(rangeMatch[2], 10);
      const step  = start <= end ? 1 : -1;
      const nums: PSObject[] = [];
      for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
        nums.push({ Line: String(n) });
      }
      return nums;
    }

    // Array literal: "a","b","c" or 1,2,3
    const arrayItems = this.tryParseArrayLiteral(trimmedCmd);
    if (arrayItems !== null) {
      return arrayItems.map(item => ({ Line: item }));
    }

    const cmdLower = trimmedCmd.split(/\s+/)[0].toLowerCase();

    // Return structured data for known cmdlets
    switch (cmdLower) {
      case 'get-process':
      case 'gps':
      case 'ps': {
        const gpArgs = this.tokenize(trimmedCmd).slice(1);
        const gpParams = this.parsePSArgs(gpArgs);
        const gpName = gpParams.get('name') ?? gpParams.get('_positional');
        const gpId = gpParams.get('id');
        const allProcs = buildDynamicProcessObjects(this.buildPSProcessCtx()) as PSObject[];
        if (gpName) return allProcs.filter(p => String(p['ProcessName'] ?? '').toLowerCase() === gpName.toLowerCase());
        if (gpId) return allProcs.filter(p => String(p['Id'] ?? '') === gpId);
        return allProcs;
      }
      case 'get-service':
      case 'gsv':
        return buildDynamicServiceObjects(this.buildPSServiceCtx()) as PSObject[];
      case 'get-command':
      case 'gcm':
        return buildCommandObjects();
      case 'get-module': {
        const moduleArgs = this.tokenize(trimmedCmd).slice(1);
        const moduleParams = this.parsePSArgs(moduleArgs);
        const listAll = moduleParams.has('listavailable');
        const modules = listAll ? PowerShellExecutor.BUILTIN_MODULES : PowerShellExecutor.BUILTIN_MODULES.slice(0, 3);
        return modules.map(m => ({ Name: m.Name, Version: m.Version, ModuleType: m.ModuleType }));
      }
      default: {
        // Fall back to string output
        const result = await this.executeSingle(cmd);
        // If this looks like a plain value (no spaces, non-cmdlet bare word) that returned an error,
        // treat the original string as a literal (handles $var substitution in pipelines)
        if (result && result.includes('is not recognized as the name of a cmdlet') &&
            /^["']?[^-\s]+["']?$/.test(trimmedCmd)) {
          return trimmedCmd.replace(/^["']|["']$/g, '');
        }
        return result ?? '';
      }
    }
  }

  // ─── Single command execution ───────────────────────────────────

  /** Tokenize a PS cmdline respecting single/double quotes. */
  private tokenize(cmdline: string): string[] {
    const tokens: string[] = [];
    let cur = '', inSingle = false, inDouble = false;
    for (let i = 0; i < cmdline.length; i++) {
      const ch = cmdline[i];
      // Backtick escape inside a double-quoted string keeps the next
      // char (typically `"` to embed a literal quote, or `n / `t / `$).
      if (inDouble && ch === '`' && i + 1 < cmdline.length) {
        cur += ch + cmdline[++i];
        continue;
      }
      if (ch === "'" && !inDouble) { inSingle = !inSingle; cur += ch; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; cur += ch; continue; }
      if ((ch === ' ' || ch === '\t') && !inSingle && !inDouble) {
        if (cur) { tokens.push(cur); cur = ''; }
      } else {
        cur += ch;
      }
    }
    if (cur) tokens.push(cur);
    return tokens;
  }

  private async executeSingle(cmdline: string): Promise<string | null> {
    const trimmedLine = cmdline.trim();

    // Quoted string literal: "hello" or 'hello' → output the unquoted value
    if (trimmedLine.startsWith('"') && trimmedLine.endsWith('"') && trimmedLine.length > 1) {
      return this.expandDoubleQuotedString(trimmedLine.slice(1, -1));
    }
    if (trimmedLine.startsWith("'") && trimmedLine.endsWith("'") && trimmedLine.length > 1) {
      return trimmedLine.slice(1, -1).replace(/''/g, "'");
    }

    // Number literal: integer or decimal
    if (/^-?\d+(\.\d+)?$/.test(trimmedLine)) return trimmedLine;

    // $Error[n].Exception.Message
    const errorAccessMatch = trimmedLine.match(/^\$Error\[(\d+)\]\.Exception\.Message$/i);
    if (errorAccessMatch) {
      const idx = parseInt(errorAccessMatch[1], 10);
      const errStr = this.errorList[idx];
      if (!errStr) return '';
      const msgMatch = errStr.match(/^[\w-]+\s*:\s*(.+)$/s);
      return msgMatch ? msgMatch[1].trim() : errStr;
    }

    // Parenthesized sub-expression: (Get-Content $Path) etc.
    if (trimmedLine.startsWith('(') && trimmedLine.endsWith(')')) {
      let depth = 0;
      let closeIdx = -1;
      for (let i = 0; i < trimmedLine.length; i++) {
        if (trimmedLine[i] === '(') depth++;
        else if (trimmedLine[i] === ')') { depth--; if (depth === 0) { closeIdx = i; break; } }
      }
      if (closeIdx === trimmedLine.length - 1) {
        return this.executeSingle(trimmedLine.slice(1, -1).trim());
      }
    }

    // Array-index property accessor: (command)[N].PropertyName
    const arrayIdxPropMatch = trimmedLine.match(/^\((.+)\)\[(\d+)\]\.(\w+)$/);
    if (arrayIdxPropMatch) {
      const innerCmd2 = arrayIdxPropMatch[1];
      const idx = parseInt(arrayIdxPropMatch[2], 10);
      const propName2 = arrayIdxPropMatch[3];
      const result2 = await this.execute(innerCmd2);
      if (!result2) return '';
      const parsed2 = parseTable(result2) ?? parseKeyValueBlocks(result2);
      if (parsed2 && parsed2.length > idx) {
        const obj2 = parsed2[idx];
        const key2 = Object.keys(obj2).find(k => k.toLowerCase() === propName2.toLowerCase());
        if (key2 !== undefined) {
          const val2 = obj2[key2];
          if (val2 === true) return 'True';
          if (val2 === false) return 'False';
          return String(val2 ?? '');
        }
      }
      const kv2 = result2.match(new RegExp(`${propName2}\\s*:\\s*(.+)`, 'i'));
      if (kv2) return kv2[1].trim();
      return '';
    }

    // Nested property accessor: (command).Prop1.Prop2
    const nestedPropMatch = trimmedLine.match(/^\((.+)\)\.(\w+)\.(\w+)$/);
    if (nestedPropMatch) {
      const innerCmd = nestedPropMatch[1];
      const prop1 = nestedPropMatch[2];
      const prop2 = nestedPropMatch[3];
      const result = await this.execute(innerCmd);
      if (!result) return '';
      const kvMatch1 = result.match(new RegExp(`${prop1}\\s*:\\s*(.+)`, 'i'));
      if (kvMatch1) {
        const prop1Value = kvMatch1[1].trim();
        if (prop2.toLowerCase() === 'name') {
          return prop1Value.split(/[\\\/]/).pop() ?? prop1Value;
        }
        const kvMatch2 = prop1Value.match(new RegExp(`${prop2}\\s*:\\s*(.+)`, 'i'));
        if (kvMatch2) return kvMatch2[1].trim();
        return prop1Value;
      }
      return '';
    }

    // .GetType().Name accessor: (expr).GetType().Name
    const getTypeNameMatch = trimmedLine.match(/^\((.+)\)\.GetType\(\)\.Name$/i);
    if (getTypeNameMatch) {
      const innerCmd = getTypeNameMatch[1].trim();
      const innerLower = innerCmd.toLowerCase();
      if (/-asbytestream\b/.test(innerLower)) return 'Byte[]';
      if (/^(get-content|gc|cat|type)\b/.test(innerLower)) return 'Object[]';
      // Execute and determine type from result
      const result = await this.execute(innerCmd);
      if (!result) return 'Object[]';
      const lines = result.split('\n').filter(l => l.trim());
      if (lines.length > 1) return 'Object[]';
      return 'String';
    }

    // Property accessor: (command).PropertyName
    const propAccessMatch = trimmedLine.match(/^\((.+)\)\.(\w+)$/);
    if (propAccessMatch) {
      const innerCmd = propAccessMatch[1];
      const propName = propAccessMatch[2];
      // Use full execute() to handle pipelines inside parentheses
      const result = await this.execute(innerCmd);
      if (!result) return propName.toLowerCase() === 'count' ? '0' : '';
      // .Count: return number of objects in the result
      if (propName.toLowerCase() === 'count') {
        // -ReadCount 0 or -Raw → whole file is ONE string → Count = 1
        const innerLower = innerCmd.toLowerCase();
        if (/-readcount\s+0(\s|$)/.test(innerLower) || /(^|\s)-raw(\s|$)/.test(innerLower)) return '1';
        const parsed = parseTable(result) ?? parseKeyValueBlocks(result);
        if (parsed) return String(parsed.length);
        const dataLines = result.split('\n').filter(l => {
          const t = l.trim();
          return t && !t.match(/^[-=]+$/) && !t.match(/^Status\s+Name/i) && !t.match(/^Name\s+Status/i);
        });
        return String(Math.max(0, dataLines.length));
      }
      // Prefer KV block when result contains extended properties (e.g. Get-Service -Name X)
      // This avoids parseTable incorrectly parsing KV lines as table data rows.
      const kvParsed = parseKeyValueBlocks(result);
      const tableParsed = parseTable(result);
      // Use KV block if it has the requested property, else use table
      const parsed = (() => {
        if (kvParsed && kvParsed.length === 1 && Object.keys(kvParsed[0]).find(k => k.toLowerCase() === propName.toLowerCase())) {
          return kvParsed;
        }
        return tableParsed ?? kvParsed;
      })();
      if (parsed && parsed.length > 0) {
        const key = Object.keys(parsed[0]).find(k => k.toLowerCase() === propName.toLowerCase());
        if (key !== undefined) {
          // Collect values from ALL objects (PowerShell array property access)
          const values = parsed.map(o => {
            const v = o[key];
            if (v === true) return 'True';
            if (v === false) return 'False';
            return String(v ?? '');
          }).filter(v => v !== '');
          return values.join('\n');
        }
      }
      // Fallback: collect ALL key:value matches (multiple objects)
      const kvAllMatches = [...result.matchAll(new RegExp(`${propName}\\s*:\\s*(.+)`, 'gi'))];
      if (kvAllMatches.length > 0) {
        return kvAllMatches.map(m => m[1].trim()).join('\n');
      }
      return '';
    }

    // [System.Environment]:: / [Environment]:: static method calls —
    // both namespaces are accepted, exactly as PowerShell resolves them.
    const dotnetStaticMatch = trimmedLine.match(/^\[(?:System\.)?Environment\]::(Set|Get)EnvironmentVariable\((.+)\)$/i);
    if (dotnetStaticMatch) {
      const method = dotnetStaticMatch[1].toLowerCase(); // 'set' or 'get'
      const rawArgs = dotnetStaticMatch[2];
      const argParts = rawArgs.split(',').map(a => a.trim().replace(/^["']|["']$/g, ''));
      if (method === 'set') {
        const [varName, value] = argParts;
        if (value === '$null' || value === '' || value === 'null') {
          this.sessionEnv.delete(varName.toUpperCase());
        } else {
          this.sessionEnv.set(varName.toUpperCase(), value);
        }
        return '';
      } else {
        const varName = argParts[0].toUpperCase();
        return this.sessionEnv.get(varName) ?? this.resolveEnvVar(varName) ?? '';
      }
    }

    const parts = this.tokenize(cmdline);
    const cmd = parts[0];
    const cmdLower = cmd.toLowerCase();
    // Strip common PS parameters that don't affect output in simulation
    const args = this.stripCommonParams(parts.slice(1));

    // -? help shortcut: any cmdlet with -? → show help
    if (args.includes('-?')) {
      return formatGetHelp(cmd);
    }

    // ─── PowerShell variables ─────────────────────────────────────
    if (cmdLower === '$psversiontable') return PS_VERSION_TABLE;

    if (cmdLower === '$host') {
      return `Name             : ConsoleHost\nVersion          : 5.1.22621.4391\nInstanceId       : 00000000-0000-0000-0000-000000000000\nUI               : System.Management.Automation.Internal.Host.InternalHostUserInterface\nCurrentCulture   : en-US\nCurrentUICulture : en-US`;
    }

    if (cmdLower === '$pwd') {
      return `\nPath\n----\n${this.cwd}\n`;
    }

    if (cmdLower.startsWith('$env:')) {
      return this.resolveEnvVar(cmd.slice(5)) ?? '';
    }

    if (cmdLower === '$true') return 'True';
    if (cmdLower === '$false') return 'False';
    if (cmdLower === '$null') return '';
    if (cmdLower === '$pid') return String(Math.floor(Math.random() * 10000 + 1000));

    // Bare variable reference: $varName (no method call, no assignment)
    if (/^\$[a-z_]\w*$/i.test(trimmedLine)) {
      const varName = trimmedLine.slice(1).toLowerCase();
      return this.sessionVars.get(varName) ?? '';
    }

    // ─── Cmdlets mapped to device commands ────────────────────────

    // Get-ChildItem / ls / dir / gci
    if (cmdLower === 'get-childitem' || cmdLower === 'gci' || cmdLower === 'ls' || cmdLower === 'dir') {
      return this.handleGetChildItem(args);
    }

    // Set-Item (handles Env: drive)
    if (cmdLower === 'set-item') {
      return this.handleSetItem(args);
    }

    // ConvertTo-SecureString (return plaintext for simulation)
    if (cmdLower === 'convertto-securestring') {
      const value = args.find(a => !a.startsWith('-'));
      return value?.replace(/^["']|["']$/g, '') ?? '';
    }

    // Set-Location / cd / sl / chdir
    if (cmdLower === 'set-location' || cmdLower === 'sl' || cmdLower === 'cd' || cmdLower === 'chdir') {
      const target = args.find(a => !a.startsWith('-')) || 'C:\\Users\\User';
      // Handle registry paths
      if (isRegistryPath(target)) {
        const hkMatch = target.match(/^HKCU:\\?(.*)$/i);
        this.cwd = hkMatch ? `HKEY_CURRENT_USER\\${hkMatch[1]}`.replace(/\\$/, '') : target;
        return '';
      }
      // Bare drive letter (`Set-Location D:`) is a drive switch in PS,
      // not a no-op like cmd's `cd D:`. Route through cmd's bare-letter
      // handler. For absolute paths, use `cd /d` so a path on another
      // drive (`Set-Location D:\Data`) actually changes the active
      // drive rather than just remembering the per-drive cwd silently.
      const driveOnly = /^([a-zA-Z]):\\?$/.exec(target);
      const cmdLine = driveOnly
        ? `${driveOnly[1]}:`
        : /^[a-zA-Z]:[\\/]/.test(target)
          ? `cd /d ${target}`
          : `cd ${target}`;
      const result = await this.device.executeCmdCommand(cmdLine);
      await this.refreshCwd();
      return result || '';
    }

    // Push-Location / pushd
    if (cmdLower === 'push-location' || cmdLower === 'pushd' || cmdLower === 'push') {
      const rawStackName = args.find((a, i) => args[i-1]?.toLowerCase() === '-stackname') ?? 'default';
      const stackName = rawStackName.replace(/^["']|["']$/g, '');
      const target = args.find(a => !a.startsWith('-')) ?? this.cwd;
      if (!this.locationStack.has(stackName)) this.locationStack.set(stackName, []);
      this.locationStack.get(stackName)!.push(this.cwd);
      await this.execute('set-location ' + target);
      return '';
    }

    // Pop-Location / popd
    if (cmdLower === 'pop-location' || cmdLower === 'popd') {
      const rawStackName = args.find((a, i) => args[i-1]?.toLowerCase() === '-stackname') ?? 'default';
      const stackName = rawStackName.replace(/^["']|["']$/g, '');
      const stack = this.locationStack.get(stackName);
      if (stack && stack.length > 0) {
        const prev = stack.pop()!;
        await this.execute('set-location ' + prev);
      }
      return '';
    }

    // Get-Location / pwd / gl
    if (cmdLower === 'get-location' || cmdLower === 'gl' || cmdLower === 'pwd') {
      return this.handleGetLocation(args);
    }

    // Get-Content / cat / type / gc
    if (cmdLower === 'get-content' || cmdLower === 'gc' || cmdLower === 'cat' || cmdLower === 'type') {
      return this.handleGetContent(args);
    }

    // Set-Content / sc
    if (cmdLower === 'set-content' || cmdLower === 'sc') {
      return this.handleSetContent(args);
    }

    // New-Item / ni
    if (cmdLower === 'new-item' || cmdLower === 'ni') {
      return this.handleNewItem(args);
    }

    // Remove-Item / ri / rm / rmdir / del
    if (cmdLower === 'remove-item' || cmdLower === 'ri' || cmdLower === 'rm' || cmdLower === 'del' || cmdLower === 'erase') {
      return this.handleRemoveItem(args);
    }

    // Get-ItemProperty / gp
    if (cmdLower === 'get-itemproperty' || cmdLower === 'gp') {
      return psGetItemProperty({ registry: this.registry }, args);
    }

    // Set-ItemProperty / sp
    if (cmdLower === 'set-itemproperty' || cmdLower === 'sp') {
      return psSetItemProperty({ registry: this.registry }, args);
    }

    // Remove-ItemProperty / rp
    if (cmdLower === 'remove-itemproperty' || cmdLower === 'rp') {
      return psRemoveItemProperty({ registry: this.registry }, args);
    }

    // Get-PSDrive / gdr — feed the registry helper the live FS drive
    // letters + actual used/free sizes so its FileSystem-provider rows
    // match `vol`, Get-Volume, `dir`'s "bytes free" line, and the bare
    // cmd drive-switch handler.
    if (cmdLower === 'get-psdrive' || cmdLower === 'gdr') {
      const fs = this.device.getFileSystem();
      const bytesToGB = (n: number) => n / 1_073_741_824;
      const drives = fs.listDrives().map(d => {
        const letter = d.charAt(0);
        return {
          letter,
          usedGB: bytesToGB(fs.getUsedSpace(letter)),
          freeGB: bytesToGB(fs.getFreeDiskSpace(letter)),
        };
      });
      return this.registry.getPSDrive(drives);
    }

    // ─── Event Log Cmdlets ────────────────────────────────────────
    if (EVENT_LOG_CMDLETS[cmdLower]) {
      return EVENT_LOG_CMDLETS[cmdLower]({ eventLog: this.eventLog }, args);
    }

    // Copy-Item / cpi / copy / cp
    if (cmdLower === 'copy-item' || cmdLower === 'cpi' || cmdLower === 'copy' || cmdLower === 'cp') {
      return this.handleCopyItem(args);
    }

    // Move-Item / mi / move / mv
    if (cmdLower === 'move-item' || cmdLower === 'mi' || cmdLower === 'move' || cmdLower === 'mv') {
      return this.handleMoveItem(args);
    }

    // Rename-Item / rni / ren
    if (cmdLower === 'rename-item' || cmdLower === 'rni' || cmdLower === 'ren') {
      return this.handleRenameItem(args);
    }

    // Write-Host / Write-Output / echo
    if (cmdLower === 'write-host' || cmdLower === 'write-output' || cmdLower === 'echo') {
      const joined = args.join(' ');
      // Expand double-quoted backtick escapes / $var when applicable.
      if (joined.startsWith('"') && joined.endsWith('"')) {
        return this.expandDoubleQuotedString(joined.slice(1, -1));
      }
      if (joined.startsWith("'") && joined.endsWith("'")) {
        return joined.slice(1, -1).replace(/''/g, "'");
      }
      return joined;
    }

    // Clear-Host / cls / clear
    if (cmdLower === 'clear-host' || cmdLower === 'cls' || cmdLower === 'clear') {
      // Clear-Host accepts no parameters except common parameters
      const commonParams = new Set(['-erroraction', '-warningaction', '-informationaction',
        '-errorvariable', '-warningvariable', '-informationvariable', '-outvariable',
        '-outbuffer', '-pipelinevariable', '-verbose', '-debug', '-whatif', '-confirm']);
      for (const a of args) {
        if (!a.startsWith('-')) {
          return `Clear-Host : A positional parameter cannot be found that accepts argument '${a}'.`;
        }
        const aLower = a.split(':')[0].toLowerCase();
        if (!commonParams.has(aLower)) {
          return `Clear-Host : A parameter cannot be found that matches parameter name '${a.slice(1)}'.`;
        }
      }
      return ''; // Screen clear is handled by the sub-shell, executor returns empty string
    }

    // Get-Process / gps / ps
    if (cmdLower === 'get-process' || cmdLower === 'gps' || cmdLower === 'ps') {
      return psGetProcess(this.buildPSProcessCtx(), args);
    }

    // Stop-Process / spps / kill
    if (cmdLower === 'stop-process' || cmdLower === 'spps' || cmdLower === 'kill') {
      return psStopProcess(this.buildPSProcessCtx(), args);
    }

    // Start-Process / saps / start
    if (cmdLower === 'start-process' || cmdLower === 'saps') {
      return psStartProcess(this.buildPSProcessCtx(), args);
    }

    // Get-ComputerInfo — OS-identity subset, sourced from the same registry
    // values `systeminfo`/`wmic os get caption` read, so a Windows Server
    // device reports its own identity here too instead of the client's.
    if (cmdLower === 'get-computerinfo') {
      const values = this.registry.getItemPropertyValues('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion') ?? {};
      const productName = String(values['ProductName'] ?? 'Windows 10 Pro');
      const editionId = String(values['EditionID'] ?? 'Professional');
      const installationType = String(values['InstallationType'] ?? 'Client');
      const buildNumber = String(values['CurrentBuildNumber'] ?? '22631');
      const releaseId = String(values['ReleaseId'] ?? '2009');
      return [
        `WindowsProductName       : ${productName}`,
        `WindowsEditionId         : ${editionId}`,
        `WindowsInstallationType  : ${installationType}`,
        `WindowsVersion           : ${releaseId}`,
        `WindowsBuildLabEx        : ${buildNumber}.1.amd64fre.ni_release`,
        `OsName                   : Microsoft ${productName}`,
        `OsVersion                : ${this.currentVersionBuild()}`,
        `OsHardwareAbstractionLayer: ${this.currentVersionBuild()}`,
        `CsDNSHostName            : ${this.device.getHostname()}`,
        `CsName                   : ${this.device.getHostname()}`,
      ].join('\n');
    }

    // Get-Help / man / help
    if (cmdLower === 'get-help' || cmdLower === 'man' || cmdLower === 'help') {
      let topic = '';
      let category = '', paramName = '', component = '', role = '', functionality = '';
      let examples = false, detailed = false, full = false, online = false, showWindow = false;
      for (let i = 0; i < args.length; i++) {
        const al = args[i].toLowerCase();
        if ((al === '-name') && args[i+1] && !args[i+1].startsWith('-')) { topic = args[++i].replace(/^["']|["']$/g, ''); }
        else if (al === '-name') {
          // -Name with no value or followed by another switch → report missing argument
          return `Get-Help : Missing an argument for parameter 'Name'. Specify a parameter of type 'System.String' and try again.`;
        }
        else if (al === '-category' && args[i+1]) { category = args[++i].replace(/^["']|["']$/g, ''); }
        else if (al === '-parameter' && args[i+1]) { paramName = args[++i].replace(/^["']|["']$/g, ''); }
        else if (al === '-component' && args[i+1]) { component = args[++i].replace(/^["']|["']$/g, ''); }
        else if (al === '-role' && args[i+1]) { role = args[++i].replace(/^["']|["']$/g, ''); }
        else if (al === '-functionality' && args[i+1]) { functionality = args[++i].replace(/^["']|["']$/g, ''); }
        else if (al === '-examples') { examples = true; }
        else if (al === '-detailed') { detailed = true; }
        else if (al === '-full') { full = true; }
        else if (al === '-online') { online = true; }
        else if (al === '-showwindow') { showWindow = true; }
        else if (al === '-path' && args[i+1]) { i++; } // ignore -Path
        else if (!args[i].startsWith('-') && !topic) { topic = args[i].replace(/^["']|["']$/g, ''); }
      }
      const helpOpts = { examples, detailed, full, online, showWindow, parameter: paramName || undefined, category: category || undefined, component: component || undefined, role: role || undefined, functionality: functionality || undefined };
      return formatGetHelp(topic || undefined, helpOpts);
    }

    // Get-Command / gcm
    if (cmdLower === 'get-command' || cmdLower === 'gcm') {
      return this.handleGetCommand(args);
    }

    // Get-Module
    if (cmdLower === 'get-module') {
      return this.handleGetModule(args);
    }

    // Get-NetIPConfiguration
    if (cmdLower === 'get-netipconfiguration') {
      return net.handleGetNetIPConfiguration(this.buildPSNetCtx(), args);
    }

    // Get-NetIPAddress
    if (cmdLower === 'get-netipaddress') {
      return net.handleGetNetIPAddress(this.buildPSNetCtx(), args);
    }

    // New-NetIPAddress
    if (cmdLower === 'new-netipaddress') {
      return net.handleNewNetIPAddress(this.buildPSNetCtx(), args);
    }

    // Remove-NetIPAddress
    if (cmdLower === 'remove-netipaddress') {
      return net.handleRemoveNetIPAddress(this.buildPSNetCtx(), args);
    }

    // Set-NetIPAddress
    if (cmdLower === 'set-netipaddress') {
      return net.handleSetNetIPAddress(this.buildPSNetCtx(), args);
    }

    // Get-NetRoute
    if (cmdLower === 'get-netroute') {
      return net.handleGetNetRoute(this.buildPSNetCtx(), args);
    }

    // New-NetRoute
    if (cmdLower === 'new-netroute') {
      return net.handleNewNetRoute(this.buildPSNetCtx(), args);
    }

    // Remove-NetRoute
    if (cmdLower === 'remove-netroute') {
      return net.handleRemoveNetRoute(this.buildPSNetCtx(), args);
    }

    // Get-DnsClientServerAddress
    if (cmdLower === 'get-dnsclientserveraddress') {
      return psGetDnsClientServerAddress(this.buildPSNetConfigCtx(), args);
    }

    // Set-DnsClientServerAddress
    if (cmdLower === 'set-dnsclientserveraddress') {
      return psSetDnsClientServerAddress(this.buildPSNetConfigCtx(), args);
    }

    // Get-NetAdapter
    if (cmdLower === 'get-netadapter') {
      return net.handleGetNetAdapter(this.buildPSNetCtx(), args);
    }

    // Test-Connection (PowerShell ping)
    if (cmdLower === 'test-connection') {
      return this.handleTestConnection(args);
    }

    // Get-NetTCPConnection (simulated netstat-like)
    if (cmdLower === 'get-nettcpconnection') {
      return net.formatGetNetTCPConnection(this.buildPSNetCtx(), args);
    }

    // Get-NetFirewallRule
    if (cmdLower === 'get-netfirewallrule') {
      return psGetNetFirewallRule({ dynamicFirewallRules: this.dynamicFirewallRules }, args);
    }

    // New-NetFirewallRule
    if (cmdLower === 'new-netfirewallrule') {
      return psNewNetFirewallRule({ dynamicFirewallRules: this.dynamicFirewallRules }, args);
    }

    // Set-NetFirewallRule
    if (cmdLower === 'set-netfirewallrule') {
      return psSetNetFirewallRule({ dynamicFirewallRules: this.dynamicFirewallRules }, args);
    }

    // Enable-NetFirewallRule
    if (cmdLower === 'enable-netfirewallrule') {
      return psToggleNetFirewallRule({ dynamicFirewallRules: this.dynamicFirewallRules }, args, true);
    }

    // Disable-NetFirewallRule
    if (cmdLower === 'disable-netfirewallrule') {
      return psToggleNetFirewallRule({ dynamicFirewallRules: this.dynamicFirewallRules }, args, false);
    }

    // Remove-NetFirewallRule
    if (cmdLower === 'remove-netfirewallrule') {
      return psRemoveNetFirewallRule({ dynamicFirewallRules: this.dynamicFirewallRules }, args);
    }

    // Disable-NetAdapter
    if (cmdLower === 'disable-netadapter') {
      return net.handleDisableEnableNetAdapter(this.buildPSNetCtx(), args, 'Disabled');
    }

    // Enable-NetAdapter
    if (cmdLower === 'enable-netadapter') {
      return net.handleDisableEnableNetAdapter(this.buildPSNetCtx(), args, 'Up');
    }

    // Rename-NetAdapter
    if (cmdLower === 'rename-netadapter') {
      return net.handleRenameNetAdapter(this.buildPSNetCtx(), args);
    }

    // Restart-NetAdapter
    if (cmdLower === 'restart-netadapter') {
      // Real restart = down then up on the actual adapter. Route through
      // the shared handler so a backing port is truly cycled (admin down →
      // up), visible to ipconfig/netsh — not just a PS-only override flip.
      net.handleDisableEnableNetAdapter(this.buildPSNetCtx(), args, 'Disabled');
      return net.handleDisableEnableNetAdapter(this.buildPSNetCtx(), args, 'Up');
    }

    // Set-NetRoute
    if (cmdLower === 'set-netroute') {
      return net.handleSetNetRoute(this.buildPSNetCtx(), args);
    }

    // Test-NetConnection
    if (cmdLower === 'test-netconnection') {
      return net.handleTestNetConnection(this.buildPSNetCtx(), args);
    }

    // Get-NetConnectionProfile
    if (cmdLower === 'get-netconnectionprofile') {
      return psGetNetConnectionProfile(this.buildPSNetConfigCtx(), args);
    }

    // Set-NetConnectionProfile
    if (cmdLower === 'set-netconnectionprofile') {
      return psSetNetConnectionProfile(this.buildPSNetConfigCtx(), args);
    }

    // Add-VpnConnection
    if (cmdLower === 'add-vpnconnection') {
      return psAddVpnConnection({ vpnConnections: this.vpnConnections }, args);
    }

    // Get-VpnConnection
    if (cmdLower === 'get-vpnconnection') {
      return psGetVpnConnection({ vpnConnections: this.vpnConnections }, args);
    }

    // Set-VpnConnection
    if (cmdLower === 'set-vpnconnection') {
      return psSetVpnConnection({ vpnConnections: this.vpnConnections }, args);
    }

    // Remove-VpnConnection
    if (cmdLower === 'remove-vpnconnection') {
      return psRemoveVpnConnection({ vpnConnections: this.vpnConnections }, args);
    }

    // Clear-DnsClientCache — flush the REAL resolver cache (the same one
    // ipconfig /flushdns and Get-DnsClientCache read), not a no-op.
    if (cmdLower === 'clear-dnsclientcache') {
      await this.device.executeCmdCommand('ipconfig /flushdns');
      return '';
    }

    // Resolve-DnsName
    if (cmdLower === 'resolve-dnsname') {
      const target = (args.find((a) => !a.startsWith('-')) ?? '').replace(
        /^["']|["']$/g,
        '',
      );
      return net.renderResolveDnsName(this.buildPSNetCtx(), target);
    }

    if (STORAGE_CMDLETS[cmdLower]) {
      return STORAGE_CMDLETS[cmdLower]({ fs: this.device.getFileSystem() }, args);
    }

    // Get-ScheduledTask — reads the SAME store cmd's schtasks writes.
    if (cmdLower === 'get-scheduledtask') {
      const nameParam = args.find((a, i) => args[i - 1]?.toLowerCase() === '-taskname') || args.find(a => !a.startsWith('-'));
      const tasks = [...this.device.scheduledTasks.values()];
      const filtered = nameParam
        ? tasks.filter(t => t.taskName.toLowerCase().includes(nameParam.replace(/^["']|["']$/g, '').toLowerCase()))
        : tasks;
      if (filtered.length === 0) {
        return nameParam
          ? `Get-ScheduledTask : No MSFT_ScheduledTask objects found with property 'TaskName' equal to '${nameParam}'.`
          : '';
      }
      const lines = ['', 'TaskPath                          TaskName                        State    ', '--------                          --------                        -----    '];
      for (const t of filtered) {
        lines.push(`${t.taskPath.padEnd(34)}${t.taskName.padEnd(32)}${t.state}`);
      }
      return lines.join('\n');
    }

    // Register-ScheduledTask — writes the SAME store cmd's schtasks reads.
    if (cmdLower === 'register-scheduledtask') {
      const nameIdx = args.findIndex(a => a.toLowerCase() === '-taskname');
      const name = nameIdx >= 0 ? args[nameIdx + 1]?.replace(/^["']|["']$/g, '') : 'Task';
      if (name) {
        this.device.scheduledTasks.set(name.toLowerCase(), { taskName: name, taskPath: '\\', state: 'Ready' });
      }
      return `\n\\${name}\n`;
    }

    // Unregister-ScheduledTask — removes from the shared store.
    if (cmdLower === 'unregister-scheduledtask') {
      const nameIdx = args.findIndex(a => a.toLowerCase() === '-taskname');
      const name = nameIdx >= 0 ? args[nameIdx + 1]?.replace(/^["']|["']$/g, '') : '';
      if (name) this.device.scheduledTasks.delete(name.toLowerCase());
      return '';
    }

    // New-ScheduledTaskAction / New-ScheduledTaskTrigger
    if (cmdLower === 'new-scheduledtaskaction' || cmdLower === 'new-scheduledtasktrigger') {
      return '';
    }


    // Set-Acl
    if (cmdLower === 'set-acl') {
      return this.handleSetAcl(args);
    }

    // New-Object (simplified stub — creates object via executeSingleStatement for $var = New-Object)
    if (cmdLower === 'new-object') {
      return '';
    }

    // Get-Date — PowerShell's default rendering is the full culture long
    // date/time ("Sunday, July 19, 2026 3:04:05 PM"), not JS's Date string.
    if (cmdLower === 'get-date') {
      return new Date().toLocaleString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
      });
    }

    // Get-History / h / history
    if (cmdLower === 'get-history' || cmdLower === 'h' || cmdLower === 'history') {
      if (this.commandHistory.length === 0) return '';
      return this.commandHistory.map((h, i) => `  ${i + 1}  ${h}`).join('\n');
    }

    // hostname
    if (cmdLower === 'hostname') {
      return this.device.getHostname();
    }

    // Intercept netsh winhttp before CMD delegation (PS-level proxy state)
    if (cmdLower === 'netsh' && args[0]?.toLowerCase() === 'winhttp') {
      return this.handleNetshWinhttp(args.slice(1));
    }

    // Intercept netsh wlan before CMD delegation (PS-level WLAN state)
    if (cmdLower === 'netsh' && args[0]?.toLowerCase() === 'wlan') {
      return this.handleNetshWlan(args.slice(1));
    }

    // Native commands that work in both CMD and PS
    if (['ipconfig', 'ping', 'netsh', 'tracert', 'route', 'arp', 'systeminfo', 'ver',
         'tasklist', 'taskkill', 'sc', 'sc.exe', 'curl', 'curl.exe',
         'nmap', 'nmap.exe'].includes(cmdLower)) {
      return await this.device.executeCmdCommand(cmdLower + ' ' + args.join(' '));
    }

    // net start/stop also works in PS
    if (cmdLower === 'net' && args.length > 0) {
      return await this.device.executeCmdCommand('net ' + args.join(' '));
    }

    // Get-ExecutionPolicy / Set-ExecutionPolicy
    if (cmdLower === 'get-executionpolicy') return 'RemoteSigned';
    if (cmdLower === 'set-executionpolicy') return '';

    // Get-Service / gsv
    if (cmdLower === 'get-service' || cmdLower === 'gsv') {
      return psGetService(this.buildPSServiceCtx(), args);
    }

    // Start-Service / sasv
    if (cmdLower === 'start-service' || cmdLower === 'sasv') {
      return psStartService(this.buildPSServiceCtx(), args);
    }

    // Stop-Service / spsv
    if (cmdLower === 'stop-service' || cmdLower === 'spsv') {
      return psStopService(this.buildPSServiceCtx(), args);
    }

    // Restart-Service
    if (cmdLower === 'restart-service') {
      return psRestartService(this.buildPSServiceCtx(), args);
    }

    // Set-Service
    if (cmdLower === 'set-service') {
      return psSetService(this.buildPSServiceCtx(), args);
    }

    // Suspend-Service
    if (cmdLower === 'suspend-service') {
      return psSuspendService(this.buildPSServiceCtx(), args);
    }

    // Resume-Service
    if (cmdLower === 'resume-service') {
      return psResumeService(this.buildPSServiceCtx(), args);
    }

    // New-Service
    if (cmdLower === 'new-service') {
      return psNewService(this.buildPSServiceCtx(), args);
    }

    // Remove-Service
    if (cmdLower === 'remove-service') {
      return psRemoveService(this.buildPSServiceCtx(), args);
    }

    // Get-WmiObject / gwmi / Get-CimInstance
    if (cmdLower === 'get-wmiobject' || cmdLower === 'gwmi' || cmdLower === 'get-ciminstance') {
      return this.formatGetCimInstance(args);
    }

    // Test-Path
    if (cmdLower === 'test-path') {
      return psTestPath(this.buildPSPathCtx(), args);
    }

    // Out-File
    if (cmdLower === 'out-file') {
      return this.handleOutFile(args);
    }

    // Add-Content / ac
    if (cmdLower === 'add-content' || cmdLower === 'ac') {
      return this.handleAddContent(args);
    }

    // Clear-Content / clc
    if (cmdLower === 'clear-content' || cmdLower === 'clc') {
      return this.handleClearContent(args);
    }

    // Get-Item / gi
    if (cmdLower === 'get-item' || cmdLower === 'gi') {
      return this.handleGetItem(args);
    }

    // Resolve-Path / rvpa
    if (cmdLower === 'resolve-path' || cmdLower === 'rvpa') {
      return psResolvePath(this.buildPSPathCtx(), args);
    }

    // Split-Path
    if (cmdLower === 'split-path') {
      return psSplitPath(args);
    }

    // Join-Path
    if (cmdLower === 'join-path') {
      return psJoinPath(args);
    }

    // ─── User/Group/ACL Management Cmdlets ──────────────────────

    // whoami (also works in PS)
    if (cmdLower === 'whoami') {
      return await this.device.executeCmdCommand('whoami ' + args.join(' '));
    }

    if (LOCAL_ACCOUNT_CMDLETS[cmdLower]) {
      return LOCAL_ACCOUNT_CMDLETS[cmdLower]({ userManager: this.device.getUserManager() }, args);
    }

    // Get-Acl
    if (cmdLower === 'get-acl') {
      return this.handleGetAcl(args);
    }

    // Write-Error / Write-Warning (executor-level fallback if interpreter misses them)
    if (cmdLower === 'write-error') {
      const msg = args.join(' ').replace(/^["']|["']$/g, '');
      return `Write-Error: ${msg}`;
    }
    if (cmdLower === 'write-warning') {
      const msg = args.join(' ').replace(/^["']|["']$/g, '');
      return `WARNING: ${msg}`;
    }
    if (cmdLower === 'write-verbose' || cmdLower === 'write-debug') return '';

    // Invoke-Expression / iex
    if (cmdLower === 'invoke-expression' || cmdLower === 'iex') {
      const expr = args.join(' ').replace(/^["']|["']$/g, '');
      return this.executeSingle(expr);
    }

    // Fallback: try device command
    return this.executeFallback(cmdline);
  }

  // ─── Helper methods ─────────────────────────────────────────────

  async refreshCwd(): Promise<void> {
    const cdResult = await this.device.executeCmdCommand('cd');
    if (cdResult && !cdResult.includes('not recognized')) {
      this.cwd = cdResult.trim();
    }
  }

  private buildPSProcessCtx() {
    const mgr = this.device.getUserManager();
    return {
      processManager: this.device.getProcessManager(),
      currentUser: mgr.currentUser,
      isAdmin: mgr.isCurrentUserAdmin(),
    };
  }

  private buildPSServiceCtx() {
    const mgr = this.device.getUserManager();
    return {
      serviceManager: this.device.getServiceManager(),
      processManager: this.device.getProcessManager(),
      isAdmin: mgr.isCurrentUserAdmin(),
    };
  }

  resolveEnvVar(varName: string): string | null {
    const upper = varName.toUpperCase();
    if (this.sessionEnv.has(upper)) return this.sessionEnv.get(upper)!;
    return this.device.getEnvVars().get(upper) ?? null;
  }

  private handleGetContent(args: string[]): string {
    const fs = this.device.getFileSystem();
    let path = '';
    let tail: number | undefined, totalCount: number | undefined, readCount: number | undefined;
    let raw = false, asByteStream = false, stream = '', wait = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if ((a === '-path' || a === '-literalpath') && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if ((a === '-tail' || a === '-last') && args[i + 1]) { tail = parseInt(args[++i], 10); }
      else if ((a === '-totalcount' || a === '-head' || a === '-first') && args[i + 1]) { totalCount = parseInt(args[++i], 10); }
      else if (a === '-readcount' && args[i + 1]) { readCount = parseInt(args[++i], 10); }
      else if (a === '-raw') { raw = true; }
      else if (a === '-asbytestream') { asByteStream = true; }
      else if (a === '-stream' && args[i + 1]) { stream = args[++i].replace(/^["']|["']$/g, ''); i++; } // skip stream name
      else if (a === '-wait') { wait = true; }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
    }
    if (!path) return '';
    const absPath = fs.normalizePath(path, this.cwd);

    // -Stream: alternate data streams not natively supported
    if (stream) {
      return `Get-Content : The -Stream parameter is not supported in this simulator.\nAt line:1 char:1\n    + CategoryInfo          : NotImplemented\n    + FullyQualifiedErrorId : NotImplemented,Microsoft.PowerShell.Commands.GetContentCommand`;
    }

    // -Wait: tail-follow not supported in simulator
    if (wait) {
      return `Get-Content : The -Wait parameter is not supported in this simulator.\nAt line:1 char:1\n    + CategoryInfo          : NotImplemented`;
    }

    // ACL enforcement: protected files require explicit Allow ACE covering the current user
    if (fs.isAclProtected(absPath)) {
      const mgr = this.device.getUserManager();
      if (!mgr.isCurrentUserAdmin()) {
        const acl = fs.getACL(absPath);
        const user = mgr.currentUser.toLowerCase();
        const isAdmin = mgr.isCurrentUserAdmin();
        const hasAllow = acl.some(ace => {
          if (ace.type !== 'allow') return false;
          const p = ace.principal.toLowerCase();
          if (p === 'everyone') return true;
          if (p === user || p.endsWith('\\' + user)) return true;
          if ((p === 'administrators' || p === 'builtin\\administrators') && isAdmin) return true;
          if ((p === 'users' || p === 'builtin\\users') && !isAdmin) return true;
          return false;
        });
        if (!hasAllow) {
          const errMsg = `Get-Content : Access to the path '${absPath}' is denied.`;
          this.errorList.unshift(errMsg);
          return errMsg;
        }
      }
    }

    const r = fs.readFile(absPath);
    if (!r.ok) return `Get-Content : Cannot find path '${path}' because it does not exist.`;
    const content = r.content ?? '';

    if (asByteStream) {
      // Return byte values as space-separated numbers
      const bytes = Array.from(content).map(c => c.charCodeAt(0));
      return bytes.join('\n');
    }

    if (raw) {
      // Return whole file as single string (no line splitting)
      return content;
    }

    if (!content) return '';
    const lines = content.split(/\r?\n/);
    if (tail !== undefined) return lines.slice(-tail).join('\n');
    if (totalCount !== undefined) return lines.slice(0, totalCount).join('\n');
    if (readCount === 0) return content; // -ReadCount 0: return as one string
    return content;
  }

  private handleGetLocation(args: string[]): string {
    const stackFlag = args.some(a => a.toLowerCase() === '-stack');
    const psDriveFlag = args.find((a, i) => args[i-1]?.toLowerCase() === '-psdrive');
    const psProviderFlag = args.find((a, i) => args[i-1]?.toLowerCase() === '-psprovider');
    const stackNameFlag = args.find((a, i) => args[i-1]?.toLowerCase() === '-stackname');

    if (stackNameFlag) {
      const stackName = stackNameFlag.replace(/^["']|["']$/g, '');
      const stack = this.locationStack.get(stackName) ?? [];
      // Show current location followed by saved stack entries
      const allPaths = [this.cwd, ...stack.slice().reverse()];
      return allPaths.map(p => `\nPath\n----\n${p}\n`).join('\n');
    }

    if (stackFlag) {
      const stack = this.locationStack.get('default') ?? [];
      // Show current location followed by saved stack entries
      const allPaths = [this.cwd, ...stack.slice().reverse()];
      return allPaths.map(p => `\nPath\n----\n${p}\n`).join('\n');
    }

    if (psDriveFlag) {
      const drive = psDriveFlag.toUpperCase().replace(/:$/, '');
      if (!['C', 'D', 'E', 'A', 'B'].includes(drive)) {
        return `Get-Location : Cannot find drive. A drive with name '${psDriveFlag}' does not exist.`;
      }
      return `\nName       : ${drive}\nPath       : ${drive}:\\\n`;
    }

    if (psProviderFlag) {
      const provider = psProviderFlag.toLowerCase();
      if (provider === 'filesystem') {
        if (!this.cwd.match(/^[A-Z]:\\/i)) {
          return `Get-Location : The current location is not set to a FileSystem provider.`;
        }
        return `\nProvider : Microsoft.PowerShell.Core\\FileSystem\nPath     : ${this.cwd}\nDrive    : ${this.cwd[0]}\n`;
      }
      if (provider === 'registry') {
        if (!this.cwd.toLowerCase().startsWith('hkey_')) {
          return `Get-Location : The current location is not set to a Registry provider location.`;
        }
        return `\nProvider : Microsoft.PowerShell.Core\\Registry\nPath     : ${this.cwd}\n`;
      }
      return `Get-Location : Cannot find a provider with the name '${psProviderFlag}'.`;
    }

    // Registry cwd
    if (this.cwd.toLowerCase().startsWith('hkey_current_user')) {
      return `\nPath\n----\n${this.cwd}\n`;
    }

    return `\nPath\n----\n${this.cwd}\n`;
  }

  private handleSetContent(args: string[]): string {
    const fs = this.device.getFileSystem();
    let path = '', value = '';
    let noNewline = false;
    const positionals: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-nonewline') { noNewline = true; }
      else if (a === '-value' && args[i + 1]) {
        const raw = args[++i];
        const items = this.tryParseArrayLiteral(raw);
        if (items) {
          // Items in the array literal still need backtick expansion.
          const expanded = items.map((it) => this.unquoteAndExpand(it));
          value = expanded.join(noNewline ? '' : '\n');
        } else {
          value = this.unquoteAndExpand(raw);
        }
      }
      else if (!args[i].startsWith('-')) {
        const raw = args[i];
        const items = this.tryParseArrayLiteral(raw);
        if (items) { positionals.push(...items.map((it) => this.unquoteAndExpand(it))); }
        else { positionals.push(this.unquoteAndExpand(raw)); }
      }
    }
    // Positional: first is path, rest are values joined by newlines or empty string
    if (!path && positionals.length > 0) path = positionals[0];
    if (!value && positionals.length > 1) value = positionals.slice(1).join(noNewline ? '' : '\n');
    if (!path) return '';
    const absPath = fs.normalizePath(path, this.cwd);
    fs.createFile(absPath, value);
    return '';
  }

  private async handleNewItem(args: string[]): Promise<string> {
    const fs = this.device.getFileSystem();
    let itemType = 'File', path = '', value = '';
    const force = args.some(a => a.toLowerCase() === '-force');
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-itemtype' && args[i + 1]) { itemType = args[++i]; }
      else if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-name' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-value' && args[i + 1]) { value = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
    }
    if (path && isRegistryPath(path)) return this.registry.newItem(path, force);
    const absPath = fs.normalizePath(path, this.cwd);
    if (itemType.toLowerCase() === 'symboliclink') {
      return `New-Item : Creating symbolic links is not supported in this simulator.\n    + CategoryInfo          : NotImplemented: (:) [New-Item], NotSupportedException\n    + FullyQualifiedErrorId : NotSupported,Microsoft.PowerShell.Commands.NewItemCommand`;
    }
    if (itemType.toLowerCase() === 'directory') {
      if (fs.exists(absPath)) {
        return force ? '' : `New-Item : An item with the specified name ${absPath} already exists.`;
      }
      fs.mkdirp(absPath);
      return '';
    }
    // File
    const parentPath = absPath.substring(0, absPath.lastIndexOf('\\'));
    if (parentPath && !fs.exists(parentPath)) {
      if (force) { fs.mkdirp(parentPath); } else { return `New-Item : Could not find a part of the path '${path}'.`; }
    }
    if (fs.exists(absPath) && !force) {
      return `New-Item : The file '${absPath}' already exists.`;
    }
    const result = fs.createFile(absPath, value);
    if (!result.ok) return `New-Item : ${result.error}`;
    return '';
  }

  // ─── Get-ChildItem with Filter/Recurse/Env: ──────────────────────

  private handleGetChildItem(args: string[], pipelinePath?: string): string {
    let path = '', filter = '';
    const include: string[] = [], exclude: string[] = [];
    let recurse = false, nameOnly = false, dirOnly = false, fileOnly = false;
    let hidden = false, system = false, force = false, readonly = false;
    let depth: number | undefined;
    let attributes = '';

    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-literalpath' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-filter' && args[i + 1]) { filter = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-include' && args[i + 1]) {
        const raw = args[++i].replace(/^["']/,'').replace(/["']$/,'');
        include.push(...raw.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')));
      }
      else if (a === '-exclude' && args[i + 1]) { exclude.push(...args[++i].replace(/^["']/,'').replace(/["']$/,'').split(',')); }
      else if (a === '-recurse') { recurse = true; }
      else if (a === '-name') { nameOnly = true; }
      else if (a === '-directory') { dirOnly = true; }
      else if (a === '-file') { fileOnly = true; }
      else if (a === '-hidden') { hidden = true; }
      else if (a === '-system') { system = true; }
      else if (a === '-readonly') { readonly = true; }
      else if (a === '-force') { force = true; }
      else if (a === '-depth' && args[i + 1]) { depth = parseInt(args[++i], 10); recurse = true; }
      else if (a === '-attributes' && args[i + 1]) { attributes = args[++i]; }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
    }

    // Pipeline input path override (from Get-Item piping)
    if (pipelinePath && !path) path = pipelinePath;

    // -Attributes validation
    const validAttrs = new Set(['hidden', 'system', 'archive', 'readonly', 'normal', 'directory', 'encrypted', 'offline', 'reparse', 'sparse', 'temporary']);
    if (attributes) {
      const attrLower = attributes.toLowerCase().replace(/^!/, '');
      if (!validAttrs.has(attrLower)) {
        return `Get-ChildItem : Cannot convert value "${attributes}" to type "System.IO.FileAttributes". Error: "Invalid value for attributes."`;
      }
    }

    // Env: drive
    if (path.toLowerCase() === 'env:' || path.toLowerCase() === 'env:\\') {
      return this.formatGetChildItemEnv();
    }

    // Registry path
    if (path && isRegistryPath(path)) return this.registry.getChildItem(path);

    const fs = this.device.getFileSystem();

    // Handle wildcard in path
    let absPath: string;
    let wildcardFilter = '';
    if (path.includes('*') || path.includes('?')) {
      const lastSep = path.lastIndexOf('\\');
      const dirPart = path.substring(0, lastSep);
      wildcardFilter = path.substring(lastSep + 1);
      absPath = fs.normalizePath(dirPart || '.', this.cwd);
      // combine with filter
      if (!filter) filter = wildcardFilter;
    } else {
      absPath = fs.normalizePath(path || '.', this.cwd);
    }

    const makeFilterFn = (name: string): boolean => {
      if (filter) {
        const rx = new RegExp('^' + filter.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        if (!rx.test(name)) return false;
      }
      if (include.length > 0) {
        const match = include.some(p => {
          const clean = p.trim().replace(/^["']|["']$/g, '');
          const rx = new RegExp('^' + clean.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i');
          return rx.test(name);
        });
        if (!match) return false;
      }
      if (exclude.length > 0) {
        const match = exclude.some(p => {
          const clean = p.trim().replace(/^["']|["']$/g, '');
          const rx = new RegExp('^' + clean.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i');
          return rx.test(name);
        });
        if (match) return false;
      }
      return true;
    };

    const applyFilter = (entries: WinDirEntry[]) =>
      entries.filter(({ entry }) => {
        if (!makeFilterFn(entry.name)) return false;
        if (dirOnly && entry.type !== 'directory') return false;
        if (fileOnly && entry.type !== 'file') return false;
        // Hidden items filtered by default; -Hidden shows ONLY hidden; -Force shows all
        if (!force && !hidden && entry.attributes.has('hidden')) return false;
        if (hidden && !force && !entry.attributes.has('hidden')) return false;
        // -System shows ONLY system items
        if (system && !force && !entry.attributes.has('system')) return false;
        return true;
      });

    const renderEntries = (filtered: WinDirEntry[], dirPath: string, lines: string[]) => {
      if (filtered.length === 0) return;
      if (nameOnly) {
        for (const { entry } of filtered) lines.push(entry.name);
      } else {
        lines.push('', `    Directory: ${dirPath}`, '', 'Mode                 LastWriteTime         Length Name', '----                 -------------         ------ ----');
        for (const { entry } of filtered) {
          const mode = this.formatPSMode(entry);
          const mtime = this.formatPSDate(entry.mtime);
          const length = entry.type === 'file' ? String(entry.size) : '';
          lines.push(`${mode.padEnd(20)} ${mtime} ${length.padStart(14)} ${entry.name}`);
        }
      }
    };

    // Error if path doesn't exist (not a wildcard query)
    const pathEntry = fs.resolve(absPath);
    if (!pathEntry && !wildcardFilter) {
      const displayPath = path || '.';
      return `Get-ChildItem : Cannot find path '${absPath}' because it does not exist.\nAt line:1 char:1\n    + CategoryInfo          : ObjectNotFound: (${displayPath}:String) [Get-ChildItem], ItemNotFoundException`;
    }

    // If path is a file (not a directory), show just the file
    if (pathEntry && pathEntry.type === 'file') {
      const parentPath = absPath.substring(0, absPath.lastIndexOf('\\')) || absPath;
      const fakeEntries: WinDirEntry[] = [{ name: pathEntry.name, entry: pathEntry }];
      const filtered = applyFilter(fakeEntries);
      if (filtered.length === 0) return '';
      const lines: string[] = [];
      renderEntries(filtered, parentPath, lines);
      return lines.join('\n');
    }

    if (recurse) {
      const allDirs = fs.listDirectoryRecursive(absPath);
      const lines: string[] = [];
      const baseDepth = absPath.split('\\').length;
      for (const { path: dirPath, entries } of allDirs) {
        const entryDepth = dirPath.split('\\').length - baseDepth;
        if (depth !== undefined && entryDepth > depth) continue;
        const filtered = applyFilter(entries);
        renderEntries(filtered, dirPath, lines);
      }
      return lines.join('\n');
    }

    const entries = fs.listDirectory(absPath);
    const filtered = applyFilter(entries);
    if (filtered.length === 0) return '';

    const lines: string[] = [];
    renderEntries(filtered, absPath, lines);
    return lines.join('\n');
  }

  private formatGetChildItemEnv(): string {
    const merged = this.device.getEnvVars();
    for (const [k, v] of this.sessionEnv) merged.set(k.toUpperCase(), v);
    const lines: string[] = ['', 'Name                           Value', '----                           -----'];
    for (const [k, v] of merged) lines.push(`${k.padEnd(31)}${v}`);
    return lines.join('\n');
  }

  private handleSetItem(args: string[]): string {
    let path = '', value = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-value' && args[i + 1]) { value = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && path && !value) { value = args[i].replace(/^["']|["']$/g, ''); }
    }
    // Handle Env: drive: Set-Item -Path Env:VARNAME -Value val
    if (path.toLowerCase().startsWith('env:')) {
      const varName = path.slice(4).replace(/^\\/, '').toUpperCase();
      this.sessionEnv.set(varName, value);
    }
    return '';
  }

  // ─── Filesystem Extended Handlers ────────────────────────────────

  private handleRemoveItem(args: string[]): string {
    let path = '';
    const recurse = args.some(a => a.toLowerCase() === '-recurse');
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
    }
    if (!path) return '';
    // Env: drive — drop the variable from session overrides.
    if (path.toLowerCase().startsWith('env:')) {
      const varName = path.slice(4).replace(/^\\/, '').toUpperCase();
      this.sessionEnv.delete(varName);
      return '';
    }
    if (isRegistryPath(path)) return this.registry.removeItem(path, recurse);
    const fs = this.device.getFileSystem();
    const absPath = fs.normalizePath(path, this.cwd);
    const entry = fs.resolve(absPath);
    if (!entry) return `Remove-Item : Cannot find path '${path}' because it does not exist.`;
    if (entry.type === 'directory') {
      if (!recurse) {
        return `Remove-Item : ${absPath} is a directory. Use -Recurse to remove the directory and all its contents.`;
      }
      const r = fs.deleteDirectory(absPath);
      return r.ok ? '' : `Remove-Item : ${r.error}`;
    }
    const r = fs.deleteFile(absPath);
    return r.ok ? '' : `Remove-Item : ${r.error}`;
  }

  private handleCopyItem(args: string[]): string {
    const fs = this.device.getFileSystem();
    let src = '', dest = '', filter = '', literalPath = '';
    const include: string[] = [], exclude: string[] = [];
    let recurse = false, force = false, passThru = false, container = false, toSession = false, whatIf = false;

    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { src = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-literalpath' && args[i + 1]) { literalPath = args[++i].replace(/^["']|["']$/g, ''); }
      else if ((a === '-destination' || a === '-dest') && args[i + 1]) { dest = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-filter' && args[i + 1]) { filter = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-include' && args[i + 1]) { include.push(...args[++i].replace(/^["']|["']$/g, '').split(',')); }
      else if (a === '-exclude' && args[i + 1]) { exclude.push(...args[++i].replace(/^["']|["']$/g, '').split(',')); }
      else if (a === '-recurse') { recurse = true; }
      else if (a === '-force') { force = true; }
      else if (a === '-passthru') { passThru = true; }
      else if (a === '-container') { container = true; }
      else if (a === '-whatif') { whatIf = true; }
      else if (a === '-tosession') { toSession = true; i++; } // skip PSSession arg
      else if (a === '-credential') { i++; } // skip credential arg (ignored in sim)
      else if (!args[i].startsWith('-') && !src && !literalPath) { src = args[i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && (src || literalPath) && !dest) { dest = args[i].replace(/^["']|["']$/g, ''); }
    }

    if (toSession) return 'Copy-Item : Remote sessions (ToSession/FromSession) are not supported in this simulator.';

    const effectiveSrcForWhatIf = literalPath || src;
    if (whatIf && effectiveSrcForWhatIf) {
      return `What if: Performing the operation "Copy File" on target "Item: ${effectiveSrcForWhatIf} Destination: ${dest}".`;
    }

    const effectiveSrc = literalPath || src;
    if (!effectiveSrc || !dest) return 'Copy-Item : Source and Destination are required.';

    const absDest = fs.normalizePath(dest, this.cwd);
    const destDrive = absDest.substring(0, 2).toUpperCase();
    if (!fs.resolve(destDrive + '\\')) fs.mkdirp(destDrive + '\\');

    // Handle wildcard in source path
    if (effectiveSrc.includes('*') || effectiveSrc.includes('?')) {
      const lastSep = effectiveSrc.lastIndexOf('\\');
      const srcDir = effectiveSrc.substring(0, lastSep);
      const pattern = effectiveSrc.substring(lastSep + 1);
      const absSrcDir = fs.normalizePath(srcDir, this.cwd);
      const filterRx = pattern ? new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
      const entries = fs.listDirectory(absSrcDir);
      fs.mkdirp(absDest);
      for (const { entry } of entries) {
        if (filterRx && !filterRx.test(entry.name)) continue;
        if (filter) {
          const filterPattern = filter.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
          if (!new RegExp('^' + filterPattern + '$', 'i').test(entry.name)) continue;
        }
        if (include.length > 0 && !include.some(p => new RegExp('^' + p.trim().replace(/["']/g,'').replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i').test(entry.name))) continue;
        if (exclude.some(p => new RegExp('^' + p.trim().replace(/["']/g,'').replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i').test(entry.name))) continue;
        if (entry.type === 'file') {
          fs.copyFile(absSrcDir + '\\' + entry.name, absDest + '\\' + entry.name);
        } else if (entry.type === 'directory' && recurse) {
          this.copyDirectoryRecursive(fs, absSrcDir + '\\' + entry.name, absDest + '\\' + entry.name, filter, include, exclude);
        }
      }
      if (passThru) {
        const destEntries = fs.listDirectory(absDest);
        if (destEntries.length > 0) return destEntries.map(e => e.entry.name).join('\n');
      }
      return '';
    }

    const absSrc = fs.normalizePath(effectiveSrc, this.cwd);
    const srcEntry = fs.resolve(absSrc);
    if (!srcEntry) {
      return `Copy-Item : Cannot find path '${absSrc}' because it does not exist.\nAt line:1 char:1\n    + CategoryInfo          : ObjectNotFound: (${absSrc}:String) [Copy-Item], ItemNotFoundException\n    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.CopyItemCommand`;
    }

    if (srcEntry.type === 'directory') {
      if (!recurse && !container) {
        return `Copy-Item : The directory '${absSrc}' is not empty. To copy the directory and its contents, use the -Recurse parameter.`;
      }
      if (container && !recurse) {
        // Check if directory has children
        const srcChildren = fs.listDirectory(absSrc);
        if (srcChildren.length > 0) {
          return `Copy-Item : The directory '${absSrc}' contains items. Use -Recurse to copy a directory with contents.`;
        }
        fs.mkdirp(absDest);
        return '';
      }
      // Recursive directory copy
      this.copyDirectoryRecursive(fs, absSrc, absDest, filter, include, exclude);
      if (passThru) return absDest.substring(absDest.lastIndexOf('\\') + 1);
      return '';
    }

    // File copy
    const destEntry = fs.resolve(absDest);
    if (destEntry && destEntry.type === 'file' && !force) {
      return `Copy-Item : The file '${absDest}' already exists. Use the Force parameter to overwrite it.\nAt line:1 char:1\n    + CategoryInfo          : WriteError: (${absDest}:String) [Copy-Item], IOException`;
    }

    const r = fs.copyFile(absSrc, absDest);
    if (!r.ok) return `Copy-Item : ${r.error}`;

    if (passThru) {
      const destName = absDest.substring(absDest.lastIndexOf('\\') + 1);
      return `Name : ${destName}\nFullName : ${absDest}`;
    }
    return '';
  }

  private copyDirectoryRecursive(fs: ReturnType<typeof this.device.getFileSystem>, srcPath: string, destPath: string, filter: string, include: string[], exclude: string[]): void {
    fs.mkdirp(destPath);
    const entries = fs.listDirectory(srcPath);
    for (const { entry } of entries) {
      if (filter) {
        const filterPattern = filter.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
        if (!new RegExp('^' + filterPattern + '$', 'i').test(entry.name)) continue;
      }
      if (include.length > 0 && !include.some(p => new RegExp('^' + p.trim().replace(/["']/g,'').replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i').test(entry.name))) continue;
      if (exclude.some(p => new RegExp('^' + p.trim().replace(/["']/g,'').replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i').test(entry.name))) continue;
      const srcChild = srcPath + '\\' + entry.name;
      const destChild = destPath + '\\' + entry.name;
      if (entry.type === 'file') {
        fs.copyFile(srcChild, destChild);
      } else {
        this.copyDirectoryRecursive(fs, srcChild, destChild, filter, include, exclude);
      }
    }
  }

  private handleMoveItem(args: string[]): string {
    const fs = this.device.getFileSystem();
    let src = '', dest = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { src = args[++i].replace(/^["']|["']$/g, ''); }
      else if ((a === '-destination' || a === '-dest') && args[i + 1]) { dest = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !src) { src = args[i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && src && !dest) { dest = args[i].replace(/^["']|["']$/g, ''); }
    }
    if (!src || !dest) return 'Move-Item : Source and Destination are required.';
    const absSrc = fs.normalizePath(src, this.cwd);
    const absDest = fs.normalizePath(dest, this.cwd);
    const r = fs.moveFile(absSrc, absDest);
    return r.ok ? '' : `Move-Item : ${r.error}`;
  }

  private handleRenameItem(args: string[]): string {
    const fs = this.device.getFileSystem();
    let path = '', newName = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if ((a === '-path' || a === '-literalpath') && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-newname' && args[i + 1]) { newName = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && path && !newName) { newName = args[i].replace(/^["']|["']$/g, ''); }
    }
    if (!path || !newName) return 'Rename-Item : -Path and -NewName are required.';
    const absPath = fs.normalizePath(path, this.cwd);
    const parentDir = absPath.substring(0, absPath.lastIndexOf('\\'));
    const absDest = parentDir + '\\' + newName;
    const r = fs.moveFile(absPath, absDest);
    return r.ok ? '' : `Rename-Item : ${r.error}`;
  }

  // ─── Event Log Handlers ───────────────────────────────────────────

  // ─── Connection Handlers ──────────────────────────────────────────

  private async handleTestConnection(args: string[]): Promise<string> {
    let target = '', countStr = '4';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-ComputerName' && args[i + 1]) { target = args[++i]; }
      else if (args[i] === '-Count' && args[i + 1]) { countStr = args[++i]; }
      else if (!args[i].startsWith('-')) { target = args[i]; }
    }
    if (!target) return "Test-Connection : Parameter 'ComputerName' is required.";
    const count = Math.max(1, parseInt(countStr, 10) || 4);

    // Execute the underlying ping to get results
    const pingOutput = await this.device.executeCmdCommand(`ping -n ${count} ${target}`);

    // Transform CMD ping output to PS Test-Connection table format
    return this.formatTestConnection(pingOutput, target, count);
  }

  private formatTestConnection(
    pingOutput: string,
    target: string,
    count: number,
  ): string {
    const lines: string[] = [];
    const source = String(this.device.getHostname());

    // Parse Reply lines from CMD ping output
    const replyLines = pingOutput.split('\n').filter(l => l.trim().startsWith('Reply from'));

    const isLocalhost =
      target === 'localhost' ||
      target === '127.0.0.1' ||
      target.toLowerCase() === this.device.getHostname().toLowerCase();

    if (replyLines.length === 0 && !isLocalhost) {
      return `Test-Connection : Testing connection to computer '${target}' failed: host unreachable.\n    + CategoryInfo          : ResourceUnavailable: (${target}:String) [Test-Connection], PingException\n    + FullyQualifiedErrorId : TestConnectionException,Microsoft.PowerShell.Commands.TestConnectionCommand`;
    }

    lines.push('Source           Destination       IPV4Address      Bytes    Time(ms) Status');
    lines.push('------           -----------       -----------      -----    -------- ------');

    // Localhost path: simulated network can't actually ping itself, so
    // synthesize `count` rows matching real PowerShell behaviour.
    const effectiveReplies =
      isLocalhost && replyLines.length === 0
        ? Array.from(
            { length: count },
            () => 'Reply from 127.0.0.1: bytes=32 time<1ms TTL=128',
          )
        : replyLines;

    for (const line of effectiveReplies) {
      const ipMatch = line.match(/Reply from ([\d.]+)/);
      const timeMatch = line.match(/time[=<](\d+)/);
      const bytesMatch = line.match(/bytes=(\d+)/);
      const ip = ipMatch ? ipMatch[1] : (isLocalhost ? '127.0.0.1' : target);
      const time = timeMatch ? timeMatch[1] : '0';
      const bytes = bytesMatch ? bytesMatch[1] : '32';
      lines.push(
        `${source.padEnd(17)}${target.padEnd(18)}${ip.padEnd(17)}${bytes.padEnd(9)}${time.padEnd(9)}Success`
      );
    }

    return lines.join('\n');
  }


  private static readonly ALL_COMMANDS: Array<{ type: string; name: string; version: string; source: string; noun: string }> = [
    { type: 'Cmdlet', name: 'Clear-Host',                    version: '3.1.0.0', source: 'Microsoft.PowerShell.Core',       noun: 'Host' },
    { type: 'Cmdlet', name: 'Copy-Item',                     version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Item' },
    { type: 'Cmdlet', name: 'Get-ChildItem',                 version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'ChildItem' },
    { type: 'Cmdlet', name: 'Get-Command',                   version: '3.0.0.0', source: 'Microsoft.PowerShell.Core',       noun: 'Command' },
    { type: 'Cmdlet', name: 'Get-Content',                   version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Content' },
    { type: 'Cmdlet', name: 'Get-Item',                      version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Item' },
    { type: 'Cmdlet', name: 'Get-ItemProperty',              version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'ItemProperty' },
    { type: 'Cmdlet', name: 'Get-Module',                    version: '3.0.0.0', source: 'Microsoft.PowerShell.Core',       noun: 'Module' },
    { type: 'Cmdlet', name: 'Get-Date',                      version: '3.1.0.0', source: 'Microsoft.PowerShell.Utility',    noun: 'Date' },
    { type: 'Cmdlet', name: 'Get-Disk',                      version: '2.0.0.0', source: 'Storage',                        noun: 'Disk' },
    { type: 'Cmdlet', name: 'Get-DnsClientServerAddress',    version: '1.0.0.0', source: 'DnsClient',                      noun: 'DnsClientServerAddress' },
    { type: 'Cmdlet', name: 'Get-EventLog',                  version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'EventLog' },
    { type: 'Cmdlet', name: 'Get-Help',                      version: '3.0.0.0', source: 'Microsoft.PowerShell.Core',       noun: 'Help' },
    { type: 'Cmdlet', name: 'Get-History',                   version: '3.0.0.0', source: 'Microsoft.PowerShell.Core',       noun: 'History' },
    { type: 'Cmdlet', name: 'Get-LocalUser',                 version: '1.0.0.0', source: 'Microsoft.PowerShell.LocalAccounts', noun: 'LocalUser' },
    { type: 'Cmdlet', name: 'Get-Location',                  version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Location' },
    { type: 'Cmdlet', name: 'Get-NetAdapter',                version: '2.0.0.0', source: 'NetAdapter',                     noun: 'NetAdapter' },
    { type: 'Cmdlet', name: 'Get-NetIPAddress',              version: '1.0.0.0', source: 'NetTCPIP',                       noun: 'NetIPAddress' },
    { type: 'Cmdlet', name: 'Get-NetIPConfiguration',        version: '1.0.0.0', source: 'NetTCPIP',                       noun: 'NetIPConfiguration' },
    { type: 'Cmdlet', name: 'Get-NetRoute',                  version: '1.0.0.0', source: 'NetTCPIP',                       noun: 'NetRoute' },
    { type: 'Cmdlet', name: 'Get-Process',                   version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Process' },
    { type: 'Cmdlet', name: 'Get-Service',                   version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Service' },
    { type: 'Cmdlet', name: 'Get-Volume',                    version: '2.0.0.0', source: 'Storage',                        noun: 'Volume' },
    { type: 'Cmdlet', name: 'Move-Item',                     version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Item' },
    { type: 'Cmdlet', name: 'New-Item',                      version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Item' },
    { type: 'Cmdlet', name: 'New-LocalUser',                 version: '1.0.0.0', source: 'Microsoft.PowerShell.LocalAccounts', noun: 'LocalUser' },
    { type: 'Cmdlet', name: 'New-NetIPAddress',              version: '1.0.0.0', source: 'NetTCPIP',                       noun: 'NetIPAddress' },
    { type: 'Cmdlet', name: 'New-NetRoute',                  version: '1.0.0.0', source: 'NetTCPIP',                       noun: 'NetRoute' },
    { type: 'Cmdlet', name: 'Remove-Item',                   version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Item' },
    { type: 'Cmdlet', name: 'Remove-LocalUser',              version: '1.0.0.0', source: 'Microsoft.PowerShell.LocalAccounts', noun: 'LocalUser' },
    { type: 'Cmdlet', name: 'Remove-NetIPAddress',           version: '1.0.0.0', source: 'NetTCPIP',                       noun: 'NetIPAddress' },
    { type: 'Cmdlet', name: 'Remove-NetRoute',               version: '1.0.0.0', source: 'NetTCPIP',                       noun: 'NetRoute' },
    { type: 'Cmdlet', name: 'Rename-Item',                   version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Item' },
    { type: 'Cmdlet', name: 'Set-Content',                   version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Content' },
    { type: 'Cmdlet', name: 'Set-DnsClientServerAddress',    version: '1.0.0.0', source: 'DnsClient',                      noun: 'DnsClientServerAddress' },
    { type: 'Cmdlet', name: 'Set-Location',                  version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Location' },
    { type: 'Cmdlet', name: 'Set-NetIPAddress',              version: '1.0.0.0', source: 'NetTCPIP',                       noun: 'NetIPAddress' },
    { type: 'Cmdlet', name: 'Set-Service',                   version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Service' },
    { type: 'Cmdlet', name: 'Start-Service',                 version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Service' },
    { type: 'Cmdlet', name: 'Stop-Process',                  version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Process' },
    { type: 'Cmdlet', name: 'Stop-Service',                  version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Service' },
    { type: 'Cmdlet', name: 'Test-Connection',               version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Connection' },
    { type: 'Cmdlet', name: 'Test-Path',                     version: '3.1.0.0', source: 'Microsoft.PowerShell.Management', noun: 'Path' },
    { type: 'Cmdlet', name: 'Write-Host',                    version: '3.1.0.0', source: 'Microsoft.PowerShell.Utility',   noun: 'Host' },
    { type: 'Cmdlet', name: 'Write-Output',                  version: '3.1.0.0', source: 'Microsoft.PowerShell.Utility',   noun: 'Output' },
    { type: 'Function', name: 'prompt',                      version: '',        source: '',                               noun: 'prompt' },
    { type: 'Alias', name: 'cls',                            version: '',        source: '',                               noun: 'cls' },
    { type: 'Alias', name: 'clear',                          version: '',        source: '',                               noun: 'clear' },
    { type: 'Alias', name: 'ls',                             version: '',        source: '',                               noun: 'ls' },
    { type: 'Alias', name: 'dir',                            version: '',        source: '',                               noun: 'dir' },
    { type: 'Alias', name: 'cd',                             version: '',        source: '',                               noun: 'cd' },
    { type: 'Alias', name: 'pwd',                            version: '',        source: '',                               noun: 'pwd' },
    { type: 'Alias', name: 'cat',                            version: '',        source: '',                               noun: 'cat' },
    { type: 'Alias', name: 'echo',                           version: '',        source: '',                               noun: 'echo' },
    { type: 'Alias', name: 'gci',                            version: '',        source: '',                               noun: 'gci' },
    { type: 'Alias', name: 'gcm',                            version: '',        source: '',                               noun: 'gcm' },
    { type: 'Alias', name: 'gps',                            version: '',        source: '',                               noun: 'gps' },
    { type: 'Alias', name: 'gsv',                            version: '',        source: '',                               noun: 'gsv' },
    { type: 'Alias', name: 'sort',                           version: '',        source: '',                               noun: 'sort' },
    { type: 'Alias', name: 'man',                            version: '',        source: '',                               noun: 'man' },
    { type: 'Alias', name: 'help',                           version: '',        source: '',                               noun: 'help' },
  ];

  private handleGetCommand(args: string[]): string {
    const params = this.parsePSArgs(args);
    const nameFilter = params.get('name') || params.get('_positional');
    const commandTypeFilter = (params.get('commandtype') ?? '').toLowerCase();
    const moduleFilter = (params.get('module') ?? '').toLowerCase();
    const nounFilter = (params.get('noun') ?? '').toLowerCase();
    const verbFilter = (params.get('verb') ?? '').toLowerCase();
    const allFlag = params.has('all');
    const argumentList = params.get('argumentlist');

    // If a specific name is requested
    if (nameFilter && !nameFilter.includes('*')) {
      const names = nameFilter.split(',').map(n => n.trim().toLowerCase());
      const found = PowerShellExecutor.ALL_COMMANDS.filter(c => names.includes(c.name.toLowerCase()));
      if (found.length === 0) {
        // Check for user-defined functions
        const userFuncs = names.filter(n => this.sessionFunctions.has(n));
        if (userFuncs.length === 0) {
          return names.map(n =>
            `Get-Command : The term '${n}' is not recognized as the name of a cmdlet, function, script file, or operable program.`
          ).join('\n');
        }
        const lines = ['CommandType     Name                                               Version    Source',
                        '-----------     ----                                               -------    ------'];
        for (const fn of userFuncs) {
          lines.push(`Function        ${fn.padEnd(51)}           `);
        }
        return lines.join('\n');
      }
      const lines = ['CommandType     Name                                               Version    Source',
                      '-----------     ----                                               -------    ------'];
      for (const c of found) {
        lines.push(`${c.type.padEnd(16)}${c.name.padEnd(51)}${c.version.padEnd(11)}${c.source}`);
      }
      return lines.join('\n');
    }

    let filtered = [...PowerShellExecutor.ALL_COMMANDS];

    // Add user-defined functions
    for (const [name] of this.sessionFunctions) {
      filtered.push({ type: 'Function', name, version: '', source: '', noun: name });
    }

    // Apply -CommandType filter
    if (commandTypeFilter) {
      if (commandTypeFilter === 'function') {
        filtered = filtered.filter(c => c.type === 'Function');
      } else if (commandTypeFilter === 'cmdlet') {
        filtered = filtered.filter(c => c.type === 'Cmdlet');
      } else if (commandTypeFilter === 'alias') {
        filtered = filtered.filter(c => c.type === 'Alias');
      }
    }

    // Apply -Noun filter
    if (nounFilter) {
      filtered = filtered.filter(c => c.noun.toLowerCase() === nounFilter);
    }

    // Apply -Verb filter
    if (verbFilter) {
      filtered = filtered.filter(c => c.name.toLowerCase().startsWith(verbFilter + '-'));
    }

    // Apply -Module filter (match source field)
    if (moduleFilter) {
      const moduleExists = PowerShellExecutor.BUILTIN_MODULES.some(m => m.Name.toLowerCase().includes(moduleFilter));
      if (!moduleExists) {
        return `Get-Command : No module with the name '${moduleFilter}' was found.`;
      }
      filtered = filtered.filter(c => c.source.toLowerCase().includes(moduleFilter));
    }

    // -TotalCount / -Skip: limit output (no error; just silently honour)
    const totalCount = params.has('totalcount') ? parseInt(params.get('totalcount') ?? '0', 10) : undefined;
    const skip = params.has('skip') ? parseInt(params.get('skip') ?? '0', 10) : undefined;

    // Apply name wildcard filter
    if (nameFilter && nameFilter.includes('*')) {
      const rx = new RegExp('^' + nameFilter.replace(/\*/g, '.*') + '$', 'i');
      filtered = filtered.filter(c => rx.test(c.name));
    }

    // -All: include duplicates (in our sim, just include everything)
    if (!allFlag) {
      // deduplicate by name (keep first occurrence)
      const seen = new Set<string>();
      filtered = filtered.filter(c => { if (seen.has(c.name.toLowerCase())) return false; seen.add(c.name.toLowerCase()); return true; });
    }

    if (filtered.length === 0) return '';

    let output = filtered;
    if (skip !== undefined) output = output.slice(skip);
    if (totalCount !== undefined) output = output.slice(0, totalCount);

    const lines = ['CommandType     Name                                               Version    Source',
                    '-----------     ----                                               -------    ------'];
    for (const c of output) {
      lines.push(`${c.type.padEnd(16)}${c.name.padEnd(51)}${c.version.padEnd(11)}${c.source}`);
    }
    return lines.join('\n');
  }

  private static readonly BUILTIN_MODULES: Array<{ Name: string; Version: string; ModuleType: string; ExportedCommands: string[] }> = [
    { Name: 'Microsoft.PowerShell.Core',           Version: '3.0.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-Command', 'Get-Help', 'Get-Module', 'Get-History', 'Clear-History', 'ForEach-Object', 'Where-Object', 'Select-Object', 'Measure-Object', 'Sort-Object', 'Group-Object', 'Out-Default', 'Out-Host', 'Out-Null', 'Out-String', 'Tee-Object', 'Import-Module'] },
    { Name: 'Microsoft.PowerShell.Management',     Version: '3.1.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-ChildItem', 'Get-Content', 'Get-Item', 'Get-ItemProperty', 'Get-Location', 'Set-Location', 'Push-Location', 'Pop-Location', 'Set-Content', 'Add-Content', 'Copy-Item', 'Move-Item', 'Rename-Item', 'Remove-Item', 'New-Item', 'Test-Path', 'Get-Process', 'Stop-Process', 'Start-Process', 'Get-Service', 'Start-Service', 'Stop-Service', 'Restart-Service'] },
    { Name: 'Microsoft.PowerShell.Utility',        Version: '3.1.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-Date', 'Write-Host', 'Write-Output', 'Write-Error', 'Write-Warning', 'Format-List', 'Format-Table', 'ConvertTo-Json', 'ConvertFrom-Json', 'Select-String', 'Compare-Object', 'Start-Sleep', 'New-TimeSpan'] },
    { Name: 'Microsoft.PowerShell.LocalAccounts',  Version: '1.0.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-LocalUser', 'New-LocalUser', 'Set-LocalUser', 'Remove-LocalUser', 'Add-LocalGroupMember', 'Get-LocalGroup', 'New-LocalGroup'] },
    { Name: 'NetTCPIP',                            Version: '1.0.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-NetIPAddress', 'New-NetIPAddress', 'Remove-NetIPAddress', 'Set-NetIPAddress', 'Get-NetIPConfiguration', 'Get-NetRoute', 'New-NetRoute', 'Remove-NetRoute'] },
    { Name: 'NetAdapter',                          Version: '2.0.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-NetAdapter', 'Disable-NetAdapter', 'Enable-NetAdapter', 'Rename-NetAdapter'] },
    { Name: 'DnsClient',                           Version: '1.0.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-DnsClientServerAddress', 'Set-DnsClientServerAddress', 'Resolve-DnsName', 'Clear-DnsClientCache'] },
    { Name: 'Storage',                             Version: '2.0.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-Disk', 'Get-Partition', 'Get-Volume', 'Initialize-Disk', 'New-Partition', 'Format-Volume'] },
  ];

  private handleGetModule(args: string[]): string {
    const params = this.parsePSArgs(args);
    const listAvailable = params.has('listavailable');
    const nameFilter = (params.get('name') ?? params.get('_positional') ?? '').toLowerCase();

    const modules = listAvailable ? PowerShellExecutor.BUILTIN_MODULES : PowerShellExecutor.BUILTIN_MODULES.slice(0, 3);
    const filtered = nameFilter
      ? modules.filter(m => m.Name.toLowerCase().includes(nameFilter))
      : modules;

    if (filtered.length === 0) return '';

    const lines = [
      '',
      'ModuleType Version    Name                                ExportedCommands',
      '---------- -------    ----                                ----------------',
    ];
    for (const m of filtered) {
      lines.push(`${m.ModuleType.padEnd(11)}${m.Version.padEnd(11)}${m.Name.padEnd(36)}${m.ExportedCommands[0]}...`);
    }
    return lines.join('\n');
  }

  // ─── PowerShell-style output formatting ─────────────────────────
  // These methods transform CMD-style output into PS-style output

  private formatGetChildItem(path: string): string {
    const fs = this.device.getFileSystem();
    const absPath = fs.normalizePath(path || '.', this.cwd);
    const entries = fs.listDirectory(absPath);
    if (entries.length === 0) return '';

    const lines: string[] = [];
    lines.push('');
    lines.push(`    Directory: ${absPath}`);
    lines.push('');
    lines.push('Mode                 LastWriteTime         Length Name');
    lines.push('----                 -------------         ------ ----');

    for (const { entry } of entries) {
      const mode = this.formatPSMode(entry);
      const mtime = this.formatPSDate(entry.mtime);
      const length = entry.type === 'file' ? String(entry.size) : '';
      lines.push(`${mode.padEnd(20)} ${mtime} ${length.padStart(14)} ${entry.name}`);
    }

    return lines.join('\n');
  }

  private formatPSMode(entry: { type: string; attributes: Set<string> }): string {
    const d = entry.type === 'directory' ? 'd' : '-';
    const a = entry.attributes.has('archive') ? 'a' : '-';
    const r = entry.attributes.has('readonly') ? 'r' : '-';
    const h = entry.attributes.has('hidden') ? 'h' : '-';
    const s = entry.attributes.has('system') ? 's' : '-';
    const l = '-'; // reparse point / link
    return d + a + r + h + s + l;
  }

  private formatPSDate(date: Date): string {
    const m = String(date.getMonth() + 1).padStart(2, ' ');
    const d = String(date.getDate()).padStart(2, ' ');
    const y = date.getFullYear();
    let h = date.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${m}/${d}/${y}  ${String(h).padStart(2)}:${min} ${ampm}`;
  }















  private buildPSNetCtx(): PSNetContext {
    return { device: this.device };
  }

  private buildPSNetConfigCtx(): PSNetConfigContext {
    return {
      ports: this.device.getPortsMap(),
      getDnsServers: (n: string) => this.device.getDnsServers(n),
      setDnsServers: (n: string, s: string[]) => this.device.setDnsServers?.(n, s),
      networkProfiles: this.networkProfiles,
    };
  }

  /**
   * Disk table. Disk 0 carries the system partition C:; one disk per
   * additional drive letter — mirroring the common "one logical volume
   * per physical disk" layout. Derived from {@link WindowsFileSystem#listDrives}
   * so a runtime-mounted drive shows up in Get-Disk too, with its
   * capacity sourced from the FS rather than a frozen "50 GB" string.
   */


  // ─── Adapter State Management ─────────────────────────────────────




  // ─── Set-NetRoute ──────────────────────────────────────────────────


  // ─── Set-NetIPAddress (upsert) ─────────────────────────────────────

  // ─── Firewall Rules ────────────────────────────────────────────────


  // ─── Network Connection Profile ────────────────────────────────────

  // ─── netsh winhttp ────────────────────────────────────────────────
  private handleNetshWinhttp(args: string[]): string {
    const sub = args[0]?.toLowerCase() ?? '';
    const rest = args.slice(1).map(a => a.toLowerCase());

    if (sub === 'show' && rest[0] === 'proxy') {
      if (!this.winhttpProxy) {
        return 'Current WinHTTP proxy settings:\n\n    Direct access (no proxy server).';
      }
      return `Current WinHTTP proxy settings:\n\n    Proxy Server(s) :  ${this.winhttpProxy}\n    Bypass List     :  (none)`;
    }

    if (sub === 'set' && rest[0] === 'proxy') {
      const proxyArg = args[2]?.replace(/^["']|["']$/g, '') ?? '';
      if (!proxyArg) return 'Usage: netsh winhttp set proxy <proxy-server> [<bypass-list>]';
      this.winhttpProxy = proxyArg;
      return `Current WinHTTP proxy settings:\n\n    Proxy Server(s) :  ${this.winhttpProxy}\n    Bypass List     :  (none)`;
    }

    if (sub === 'reset' && rest[0] === 'proxy') {
      this.winhttpProxy = '';
      return 'Current WinHTTP proxy settings:\n\n    Direct access (no proxy server).';
    }

    if (sub === 'import' && rest[0] === 'proxy') {
      return 'Current WinHTTP proxy settings are set to match those of Internet Explorer.\n(Direct access - no proxy server.)';
    }

    return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\nimport         - Imports WinHTTP proxy settings.\nreset          - Resets WinHTTP settings.\nset            - Configures WinHTTP settings.\nshow           - Displays current settings.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
  }

  // ─── netsh wlan ───────────────────────────────────────────────────
  private handleNetshWlan(args: string[]): string {
    const sub = args[0]?.toLowerCase() ?? '';
    const arg1 = args[1]?.toLowerCase() ?? '';

    // show profiles
    if (sub === 'show' && arg1 === 'profiles') {
      const profileFilter = args.slice(2).join(' ').match(/name="?([^"]+)"?/i)?.[1];
      if (profileFilter) {
        const key = profileFilter.toLowerCase();
        const name = [...this.wlanProfiles].find(p => p.toLowerCase() === key);
        if (!name) return `There is no profile "name" to show on this interface.`;
        return `Profile ${name} on interface Wi-Fi:\n=======================================================================\n\nProfile information\n-------------------\n    Applied:                All User Profile\n    Profile name            : ${name}\n    SSID name               : "${name}"\n    Connection mode         : Connect automatically\n    Network broadcast       : Connect only if this network is broadcasting\n`;
      }
      if (this.wlanProfiles.size === 0) {
        return `Profiles on interface Wi-Fi:\n\nUser profiles\n-------------\n    <None>\n`;
      }
      const profileLines = [...this.wlanProfiles].map(p => `    All User Profile     : ${p}`).join('\n');
      return `Profiles on interface Wi-Fi:\n\nUser profiles\n-------------\n${profileLines}\n`;
    }

    // show interfaces
    if (sub === 'show' && arg1 === 'interfaces') {
      const state = this.wlanConnectedSSID ? 'Connected' : 'Disconnected';
      const ssidLine = this.wlanConnectedSSID ? `    SSID                   : ${this.wlanConnectedSSID}\n` : '';
      return `There is 1 interface on the system:\n\n    Name                   : Wi-Fi\n    Description            : Intel(R) Wi-Fi 6 AX201\n    GUID                   : b1234567-89ab-cdef-0123-456789abcdef\n    Physical address       : 00:11:22:33:44:55\n    State                  : ${state}\n${ssidLine}    Radio status           : Hardware On\n                             Software On\n`;
    }

    // show networks
    if (sub === 'show' && arg1 === 'networks') {
      return `Interface name : Wi-Fi\nThere are 2 networks currently visible.\n\nSSID 1 : HomeNetwork\n    Network type            : Infrastructure\n    Authentication          : WPA2-Personal\n    Encryption              : CCMP\n\nSSID 2 : OfficeNet\n    Network type            : Infrastructure\n    Authentication          : WPA2-Personal\n    Encryption              : CCMP\n`;
    }

    // add profile
    if (sub === 'add' && arg1 === 'profile') {
      const nameArg = args.slice(2).join(' ').match(/name="?([^"]+)"?/i)?.[1];
      if (nameArg) {
        this.wlanProfiles.add(nameArg);
        return `Profile ${nameArg} is added on interface Wi-Fi.`;
      }
      return 'Usage: netsh wlan add profile name="<profile-name>"';
    }

    // delete profile
    if (sub === 'delete' && arg1 === 'profile') {
      const nameArg = args.slice(2).join(' ').match(/name="?([^"]+)"?/i)?.[1];
      if (nameArg) {
        this.wlanProfiles.delete(nameArg);
        if (this.wlanConnectedSSID.toLowerCase() === nameArg.toLowerCase()) {
          this.wlanConnectedSSID = '';
        }
        return `Profile "${nameArg}" is deleted from interface Wi-Fi.`;
      }
      return 'Usage: netsh wlan delete profile name="<profile-name>"';
    }

    // connect
    if (sub === 'connect') {
      const nameArg = args.slice(1).join(' ').match(/name="?([^"]+)"?/i)?.[1];
      if (nameArg) {
        this.wlanConnectedSSID = nameArg;
        this.wlanProfiles.add(nameArg);
        return `Connection request was completed successfully.`;
      }
      return 'Usage: netsh wlan connect name="<profile-name>"';
    }

    // disconnect
    if (sub === 'disconnect') {
      this.wlanConnectedSSID = '';
      return 'Disconnection request was completed successfully.';
    }

    return `The following commands are available:\n\nCommands in this context:\n?              - Displays a list of commands.\ndump           - Displays a configuration script.\nhelp           - Displays a list of commands.\n\nTo view help for a command, type the command, followed by a space, and then\n type ?.`;
  }






  private formatGetCimInstance(args: string[]): string {
    const className = args.find(a => !a.startsWith('-')) || '';
    if (className.toLowerCase() === 'win32_operatingsystem') {
      return `SystemDirectory : C:\\Windows\\system32\nOrganization    : \nBuildNumber     : 22631\nRegisteredUser  : User\nSerialNumber    : 00000-00000-00000-AA000\nVersion         : 10.0.22631`;
    }
    if (className.toLowerCase() === 'win32_computersystem') {
      const domain = this.device.getDomainMembership?.()?.dnsName ?? 'WORKGROUP';
      return `Domain              : ${domain}\nManufacturer        : Microsoft Corporation\nModel               : Virtual Machine\nName                : ${this.device.getHostname()}\nPrimaryOwnerName    : User\nTotalPhysicalMemory : 8589934592`;
    }
    return `Get-CimInstance : Invalid class "${className}"`;
  }

  // ─── File management cmdlets ────────────────────────────────────

  private buildPSPathCtx(): PSPathContext {
    return { fs: this.device.getFileSystem(), cwd: this.cwd, registry: this.registry };
  }

  private async handleOutFile(args: string[]): Promise<string> {
    let filePath = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-FilePath' && args[i + 1]) { filePath = args[++i]; }
      else if (!args[i].startsWith('-') && !filePath) { filePath = args[i]; }
    }
    if (!filePath) return "Out-File : Cannot bind argument to parameter 'FilePath' because it is an empty string.";
    // Out-File with no pipeline input creates empty file
    return await this.device.executeCmdCommand(`echo. > ${filePath}`);
  }

  private async handleAddContent(args: string[]): Promise<string> {
    let filePath = '', value = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-Path' && args[i + 1]) { filePath = args[++i]; }
      else if (args[i] === '-Value' && args[i + 1]) { value = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !filePath) { filePath = args[i]; }
    }
    if (!filePath) return "Add-Content : Cannot bind argument to parameter 'Path' because it is an empty string.";
    if (value) {
      return await this.device.executeCmdCommand(`echo ${value} >> ${filePath}`);
    }
    return '';
  }

  private async handleClearContent(args: string[]): Promise<string> {
    let filePath = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-Path' && args[i + 1]) { filePath = args[++i]; }
      else if (!args[i].startsWith('-') && !filePath) { filePath = args[i]; }
    }
    if (!filePath) return "Clear-Content : Cannot bind argument to parameter 'Path' because it is an empty string.";
    const fs = this.device.getFileSystem();
    const absPath = fs.normalizePath(filePath, this.cwd);
    if (!fs.exists(absPath)) return `Clear-Content : Cannot find path '${filePath}' because it does not exist.`;
    fs.createFile(absPath, '');
    return '';
  }

  private handleGetItem(args: string[]): string {
    const silentlyContinue = args.some(a => a.toLowerCase() === 'silentlycontinue');
    const target = args.filter(a => !a.startsWith('-') && a.toLowerCase() !== 'silentlycontinue').join(' ');
    if (!target) return "Get-Item : Cannot bind argument to parameter 'Path' because it is an empty string.";
    if (isRegistryPath(target)) return this.registry.getItem(target);
    const fs = this.device.getFileSystem();
    const absPath = fs.normalizePath(target, this.cwd);
    const entry = fs.resolve(absPath);
    if (!entry) {
      const errMsg = `Get-Item : Cannot find path '${target}' because it does not exist.`;
      this.errorList.unshift(errMsg);
      return silentlyContinue ? '' : errMsg;
    }

    const isDir = entry.type === 'directory';
    const mode = this.formatPSMode(entry);
    const mtime = this.formatPSDate(entry.mtime);
    const length = isDir ? '' : String(entry.size);
    const parentDir = absPath.substring(0, absPath.lastIndexOf('\\')) || (absPath + '\\');
    const attrNames = [...entry.attributes].map(a => a.charAt(0).toUpperCase() + a.slice(1));
    if (isDir && !attrNames.includes('Directory')) attrNames.push('Directory');
    if (!isDir && !attrNames.some(a => a.toLowerCase() === 'archive')) attrNames.push('Archive');
    const attrStr = attrNames.join(', ');

    const lines: string[] = [];
    lines.push('');
    lines.push(`    Directory: ${parentDir}`);
    lines.push('');
    lines.push('Mode                 LastWriteTime         Length Name');
    lines.push('----                 -------------         ------ ----');
    lines.push(`${mode.padEnd(20)} ${mtime} ${length.padStart(14)} ${entry.name}`);
    // K:V properties — used by property accessor (Get-Item ...).PropName
    lines.push('');
    lines.push(`FullName      : ${absPath}`);
    lines.push(`Name          : ${entry.name}`);
    lines.push(`Length        : ${length || '0'}`);
    lines.push(`Mode          : ${mode}`);
    lines.push(`Attributes    : ${attrStr}`);
    lines.push(`IsReadOnly    : ${entry.attributes.has('readonly') ? 'True' : 'False'}`);
    lines.push(`LastWriteTime : ${mtime}`);
    lines.push(`PSIsContainer : ${isDir ? 'True' : 'False'}`);
    lines.push('');
    return lines.join('\n');
  }

  // ─── User/Group/ACL Management Cmdlet Handlers ─────────────────

  /**
   * Strip common PS parameters that take a value or are boolean flags
   * and don't affect simulator output: -ErrorAction, -WarningAction, -OutVariable,
   * -InformationVariable, -Verbose, -Debug, -WhatIf (return WhatIf marker), -Confirm,
   * -ErrorVariable, -InformationAction.
   */
  private stripCommonParams(args: string[]): string[] {
    const valueParams = new Set([
      'erroraction', 'warningaction', 'outvariable', 'informationvariable',
      'errorvariable', 'informationaction', 'pipelinevariable',
    ]);
    const flagParams = new Set(['verbose', 'debug', 'whatif']);
    const result: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const lower = args[i].toLowerCase();
      // -Confirm:$false / -Confirm:$true → skip
      if (lower.startsWith('-confirm')) continue;
      // -WhatIf → keep as marker (handled by callers)
      if (lower === '-whatif') { result.push(args[i]); continue; }
      const paramName = lower.replace(/^-/, '');
      if (valueParams.has(paramName)) { i++; continue; } // skip param + value
      if (flagParams.has(paramName)) continue; // skip flag
      result.push(args[i]);
    }
    return result;
  }

  /**
   * Reassemble tokens that were split mid-quote, then parse PS-style args.
   * e.g. ['-Description', '"Updated', 'desc"'] → {description: 'Updated desc'}
   */
  private parsePSArgs(args: string[]): Map<string, string> {
    return parsePSArgs(args);
  }

  private handleGetAcl(args: string[]): string {
    const fs = this.device.getFileSystem();
    const params = this.parsePSArgs(args);
    const target = params.get('path') || params.get('_positional') || '';
    if (!target) return "Get-Acl : Cannot bind argument to parameter 'Path' because it is an empty string.";

    const absPath = fs.normalizePath(target, this.cwd);
    if (!fs.exists(absPath)) return `Get-Acl : Cannot find path '${target}' because it does not exist.`;

    const owner = fs.getOwner(absPath);
    const acl = fs.getACL(absPath);

    const defaultAces = acl.length === 0 ? [
      { principal: 'BUILTIN\\Administrators', type: 'allow', permissions: ['FullControl'] },
      { principal: 'BUILTIN\\Users', type: 'allow', permissions: ['ReadAndExecute'] },
      { principal: 'NT AUTHORITY\\SYSTEM', type: 'allow', permissions: ['FullControl'] },
    ] : acl;

    const lines: string[] = [''];
    lines.push(`    Path   : Microsoft.PowerShell.Core\\FileSystem::${absPath}`);
    lines.push(`    Owner  : ${owner}`);
    lines.push(`    Group  : BUILTIN\\Administrators`);
    lines.push('');
    lines.push('FileSystemRights  AccessControlType IdentityReference       IsInherited InheritanceFlags PropagationFlags');
    lines.push('----------------  ----------------- -----------------       ----------- ---------------- ----------------');
    for (const ace of defaultAces) {
      const rights = ace.permissions.join(', ');
      const type = ace.type === 'allow' ? 'Allow' : 'Deny';
      const AccessControlType = type;
      lines.push(`${rights.padEnd(18)}${AccessControlType.padEnd(18)}${ace.principal.padEnd(24)}False       ContainerInherit None`);
    }
    return lines.join('\n');
  }

  private handleSetAcl(args: string[]): string {
    const fs = this.device.getFileSystem();
    let path = '';
    let aclVarName = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-aclobject' && args[i + 1]) { aclVarName = args[++i].replace(/^\$/, '').toLowerCase(); }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !aclVarName) {
        aclVarName = args[i].replace(/^["'\$]|["']$/g, '').toLowerCase();
      }
    }
    if (!path || !aclVarName) return '';
    const aclObj = this.sessionObjects.get(aclVarName);
    if (!aclObj || aclObj.kind !== 'acl') return '';

    const absPath = fs.normalizePath(path, this.cwd);
    if (!fs.exists(absPath)) return '';

    if (aclObj.protected) {
      // Replace entire ACL with the new rules
      const entry = (fs as any).resolve(absPath);
      if (entry) {
        entry.acl = aclObj.rules.map(r => ({
          principal: r.principal,
          type: r.ruleType.toLowerCase() as 'allow' | 'deny',
          permissions: [r.permission],
          protected: true,
        }));
        // Mark as protected so Get-Content can check it
        entry.aclProtected = true;
      }
    } else {
      // Merge rules into existing ACL
      for (const rule of aclObj.rules) {
        fs.addACE(absPath, {
          principal: rule.principal,
          type: rule.ruleType.toLowerCase() as 'allow' | 'deny',
          permissions: [rule.permission],
        });
      }
    }

    const lastRule = aclObj.rules[aclObj.rules.length - 1];
    this.device.getBus().publish({
      topic: 'windows.filesystem.acl-changed',
      payload: {
        deviceId: this.device.id,
        path: absPath,
        identity: lastRule?.principal ?? '',
        permissions: lastRule?.permission ?? '',
        changedBy: this.device.getUserManager().currentUser,
      },
    });
    return '';
  }

  /**
   * Render a uniform DNS lookup table. An IPv4 input flips to a reverse
   * (`PTR`) record at `<reversed>.in-addr.arpa`; anything else is
   * answered with a forward (`A`) record pointing at a stable fake
   * address (mirrors what previous releases of the simulator did).
   */

  /**
   * Execute a `.ps1` file from the simulated filesystem.
   *
   * Resolves the path, reads its contents, then dispatches each
   * statement (split on `;` and newlines) through `execute`. Named
   * arguments on the call site are pre-installed into `sessionVars`
   * so that `param($Foo)` blocks see their values; positional
   * arguments are exposed via the standard `$args` array.
   *
   * The `param(...)` block at the top of the file is stripped before
   * execution so it doesn't get re-evaluated as a free expression.
   */
  private async invokeScriptFile(
    scriptPath: string,
    argString: string,
  ): Promise<string> {
    const fs = this.device.getFileSystem();
    const abs = fs.normalizePath(scriptPath, this.cwd);
    const entry = fs.resolve(abs);
    if (!entry || entry.type !== 'file') {
      return (
        `& : The term '${scriptPath}' is not recognized as the name of a ` +
        `cmdlet, function, script file, or operable program. Check the ` +
        `spelling of the name, or if a path was included, verify that the ` +
        `path is correct and try again.`
      );
    }
    const body = entry.content;

    // Parse the script's `param(...)` block (if any) so we know which
    // names are formal parameters. Strip it from the executable body.
    // Splitting on the top-level commas only is good enough for our
    // simulator — type accelerators like `[int[]]` don't contain `,`.
    const paramMatch = body.match(/^\s*param\s*\(([\s\S]*?)\)\s*/i);
    const paramNames: string[] = [];
    const paramDefaults = new Map<string, string>();
    let runnable = body;
    if (paramMatch) {
      const inside = paramMatch[1];
      // Track parenthesis depth so `= (1..10)` defaults survive comma
      // splitting.
      const items: string[] = [];
      let buf = '';
      let depth = 0;
      for (const ch of inside) {
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (ch === ',' && depth === 0) {
          items.push(buf);
          buf = '';
        } else {
          buf += ch;
        }
      }
      if (buf.trim()) items.push(buf);
      for (const raw of items) {
        const m = raw.match(/\$(\w+)\s*(?:=\s*([\s\S]+))?$/);
        if (!m) continue;
        const name = m[1].toLowerCase();
        paramNames.push(name);
        if (m[2] !== undefined) paramDefaults.set(name, m[2].trim());
      }
      runnable = body.slice(paramMatch[0].length);
    }

    // Tokenize the call-site arguments.
    const tokens = this.tokenize(argString);
    const positional: string[] = [];
    const named = new Map<string, string>();
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.startsWith('-') && tok.length > 1) {
        const key = tok.slice(1).toLowerCase();
        if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
          named.set(key, tokens[++i]);
        } else {
          named.set(key, 'true');
        }
      } else {
        positional.push(tok);
      }
    }

    // Snapshot current sessionVars so we can restore on `&` (non-dot)
    // invocation. We always restore — the cost is cheap and it keeps the
    // simulator consistent with PS's child-scope semantics.
    const savedVars = new Map(this.sessionVars);
    const savedObjects = new Map(this.sessionObjects);

    // Bind declared parameters: caller-supplied value wins, otherwise
    // use the default expression from the param block.
    for (const name of paramNames) {
      const v = named.get(name);
      if (v !== undefined) {
        const resolved = await this.resolveScriptArg(v);
        this.sessionVars.set(name, resolved);
      } else if (paramDefaults.has(name)) {
        const resolved = await this.resolveScriptArg(paramDefaults.get(name)!);
        this.sessionVars.set(name, resolved);
      }
    }
    for (const [k, v] of named) {
      if (!paramNames.includes(k)) {
        const resolved = await this.resolveScriptArg(v);
        this.sessionVars.set(k, resolved);
      }
    }
    this.sessionVars.set(
      'args',
      positional.map((p) => p.replace(/^["']|["']$/g, '')).join(' '),
    );

    try {
      const out = await this.execute(runnable);
      return out ?? '';
    } finally {
      // Restore previous variable scope (mimic & subshell semantics).
      // Dot-sourcing technically keeps them, but our simulator treats
      // every script call as creating a fresh scope.
      this.sessionVars = savedVars;
      this.sessionObjects = savedObjects;
    }
  }

  /**
   * Resolve a raw argument value passed to a script — handles
   * `(1..10)` ranges and bare integers. Strings are returned verbatim
   * (with surrounding quotes stripped).
   */
  private async resolveScriptArg(raw: string): Promise<string> {
    const t = raw.trim().replace(/^["']|["']$/g, '');
    const rangeMatch = t.match(/^\((\d+)\.\.(\d+)\)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      const arr: number[] = [];
      const step = a <= b ? 1 : -1;
      for (let n = a; step > 0 ? n <= b : n >= b; n += step) arr.push(n);
      return arr.join(',');
    }
    return t;
  }

  private async executeFallback(cmdline: string): Promise<string> {
    const cmd = cmdline.split(/\s+/)[0];
    try {
      const result = await this.device.executeCmdCommand(cmdline);
      if (result.includes('not recognized')) {
        return `${cmd} : The term '${cmd}' is not recognized as the name of a cmdlet, function, script file, or operable\nprogram. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.\nAt line:1 char:1\n+ ${cmdline}\n+ ${'~'.repeat(cmdline.length)}\n    + CategoryInfo          : ObjectNotFound: (${cmd}:String) [], CommandNotFoundException\n    + FullyQualifiedErrorId : CommandNotFoundException`;
      }
      return result;
    } catch {
      return `${cmd} : The term '${cmd}' is not recognized as the name of a cmdlet, function, script file, or operable\nprogram.`;
    }
  }
}
