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
import {
  runPipeline, formatDefault, formatTable,
  buildProcessObjects, buildServiceObjects, buildCommandObjects,
  parseTable, parseKeyValueBlocks,
  type PSObject, type PipelineInput,
} from './PSPipeline';
import { psGetProcess, psStopProcess, buildDynamicProcessObjects } from './PSProcessCmdlets';
import {
  psGetService, psStartService, psStopService, psRestartService,
  psSetService, psSuspendService, psResumeService,
  psNewService, psRemoveService, buildDynamicServiceObjects,
} from './PSServiceCmdlets';
import { PSRegistryProvider, isRegistryPath } from './PSRegistryProvider';
import { PSEventLogProvider, type EntryType } from './PSEventLogProvider';

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

export const PS_BANNER = `Windows PowerShell
Copyright (C) Microsoft Corporation. All rights reserved.

Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows
`;

export const PS_CMDLETS_LIST = [
  'Get-ChildItem', 'Set-Location', 'Get-Location', 'Get-Content', 'Set-Content',
  'New-Item', 'Remove-Item', 'Copy-Item', 'Move-Item', 'Rename-Item',
  'Write-Host', 'Write-Output', 'Clear-Host', 'Get-Process', 'Get-Help',
  'Get-Command', 'Get-NetIPConfiguration', 'Get-NetIPAddress', 'Get-NetAdapter',
  'Test-Connection', 'Get-Date', 'Get-History', 'Get-ExecutionPolicy',
  'Set-ExecutionPolicy', 'Get-Service', 'Get-CimInstance', 'Resolve-DnsName',
  'Select-String', 'Measure-Object', 'Sort-Object', 'Select-Object',
  'Format-Table', 'Format-List', 'Where-Object', 'ForEach-Object',
  // User/Group/ACL management
  'Get-LocalUser', 'New-LocalUser', 'Set-LocalUser', 'Remove-LocalUser',
  'Enable-LocalUser', 'Disable-LocalUser',
  'Get-LocalGroup', 'New-LocalGroup', 'Remove-LocalGroup',
  'Add-LocalGroupMember', 'Remove-LocalGroupMember', 'Get-LocalGroupMember',
  'Get-Acl',
  // Service/Process management
  'Start-Service', 'Stop-Service', 'Restart-Service', 'Set-Service',
  'Suspend-Service', 'Resume-Service', 'New-Service', 'Remove-Service',
  'Stop-Process',
  // Aliases
  'ls', 'dir', 'cd', 'pwd', 'cat', 'type', 'echo', 'cls', 'clear',
  'cp', 'mv', 'rm', 'del', 'ren', 'mkdir', 'rmdir',
  'ipconfig', 'ping', 'netsh', 'tracert', 'arp', 'route',
  'hostname', 'systeminfo', 'ver', 'exit', 'cmd',
];

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
  getDefaultGateway(): string | null;
  /** Get DNS servers for an interface */
  getDnsServers(ifName: string): string[];
  /** Set DNS servers for an interface (optional - for Set-DnsClientServerAddress) */
  setDnsServers?(ifName: string, servers: string[]): void;
  /** Check if interface uses DHCP */
  isDHCPConfigured(ifName: string): boolean;
  /** Get the user manager for access control cmdlets */
  getUserManager(): WindowsUserManager;
  /** Get the service manager for service lifecycle cmdlets */
  getServiceManager(): WindowsServiceManager;
  /** Get the process manager for process management cmdlets */
  getProcessManager(): WindowsProcessManager;
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
  private registry: PSRegistryProvider;
  private eventLog: PSEventLogProvider;
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
  /** Additional IP addresses: ip → { ifAlias, prefixLength, origin, skipAsSource, gateway } */
  private extraIPs: Map<string, { ifAlias: string; prefixLength: number; prefixOrigin: string; suffixOrigin: string; skipAsSource: boolean; gateway?: string; addressFamily: string }> = new Map();
  /** Extra routes: destPrefix → { ifAlias, nextHop, metric } */
  private extraRoutes: Map<string, { ifAlias: string; nextHop: string; metric: number }> = new Map();
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

  constructor(device: PSDeviceContext, initialCwd = 'C:\\Users\\User') {
    this.cwd = initialCwd;
    this.device = device;
    this.commandHistory = [];
    this.registry = new PSRegistryProvider();
    this.eventLog = new PSEventLogProvider();
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
        case 'os':                   return 'Microsoft Windows 10.0.19041';
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
  private expandDoubleQuotedString(inner: string): string {
    // Expand $($var) or $(expr) subexpressions
    let result = inner.replace(/\$\(([^)]*)\)/g, (_match, sub) => {
      const substituted = sub.replace(/\$(\w+)/g, (_m: string, n: string) => {
        const lo = n.toLowerCase();
        if (lo === 'true') return 'True';
        if (lo === 'false') return 'False';
        return this.sessionVars.get(lo) ?? _m;
      });
      return this.tryEvalExpr(substituted) ?? substituted;
    });
    // Expand remaining $var references
    result = result.replace(/\$(\w+)/g, (_match, n) => {
      const lo = n.toLowerCase();
      if (lo === 'true') return 'True';
      if (lo === 'false') return 'False';
      if (lo === 'null') return '';
      return this.sessionVars.get(lo) ?? _match;
    });
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
                 '-like', '-notlike', '-match', '-notmatch', '-replace', '-contains', '-in'];
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
    }).replace(/\$(\w+)/g, (match, name) => {
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
            // Replace $_.PropName with the property value from the object
            cmd = cmd.replace(/\$_\.(\w+)/g, (_, prop) => {
              const key = Object.keys(obj).find(k => k.toLowerCase() === prop.toLowerCase());
              return key !== undefined ? String(obj[key] ?? '') : '';
            });
            // Replace bare $_ with the Name property or first property
            cmd = cmd.replace(/\$_(?=\W|$)/g, () => {
              const nameKey = Object.keys(obj).find(k => k.toLowerCase() === 'name');
              if (nameKey) return String(obj[nameKey] ?? '');
              const firstKey = Object.keys(obj)[0];
              return firstKey ? String(obj[firstKey] ?? '') : '';
            });
            const result = await this.executeSingle(cmd.trim());
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
          const result = await this.executeSingle(cmd.trim());
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

    // Array literal: "a","b","c" or 1,2,3
    const arrayItems = this.tryParseArrayLiteral(trimmedCmd);
    if (arrayItems !== null) {
      return arrayItems.map(item => ({ Line: item }));
    }

    const cmdLower = trimmedCmd.split(/\s+/)[0].toLowerCase();

    // Return structured data for known cmdlets
    switch (cmdLower) {
      case 'get-process':
      case 'gps': {
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
        const parsed = parseTable(result) ?? parseKeyValueBlocks(result);
        if (parsed) return String(parsed.length);
        const dataLines = result.split('\n').filter(l => {
          const t = l.trim();
          return t && !t.match(/^[-=]+$/) && !t.match(/^Status\s+Name/i) && !t.match(/^Name\s+Status/i);
        });
        return String(Math.max(0, dataLines.length));
      }
      const parsed = parseTable(result) ?? parseKeyValueBlocks(result);
      if (parsed && parsed.length > 0) {
        const obj = parsed[0];
        const key = Object.keys(obj).find(k => k.toLowerCase() === propName.toLowerCase());
        if (key !== undefined) {
          const val = obj[key];
          if (val === true) return 'True';
          if (val === false) return 'False';
          return String(val ?? '');
        }
      }
      // Fallback: search for "PropName : Value" in the output
      const kvMatch = result.match(new RegExp(`${propName}\\s*:\\s*(.+)`, 'i'));
      if (kvMatch) return kvMatch[1].trim();
      return '';
    }

    // [System.Environment]:: static method calls
    const dotnetStaticMatch = trimmedLine.match(/^\[System\.Environment\]::(Set|Get)EnvironmentVariable\((.+)\)$/i);
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
      return this.formatGetHelp(cmd);
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
      const result = await this.device.executeCmdCommand('cd ' + target);
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
      return this.handleGetItemProperty(args);
    }

    // Set-ItemProperty / sp
    if (cmdLower === 'set-itemproperty' || cmdLower === 'sp') {
      return this.handleSetItemProperty(args);
    }

    // Remove-ItemProperty / rp
    if (cmdLower === 'remove-itemproperty' || cmdLower === 'rp') {
      return this.handleRemoveItemProperty(args);
    }

    // Get-PSDrive / gdr
    if (cmdLower === 'get-psdrive' || cmdLower === 'gdr') {
      return this.registry.getPSDrive();
    }

    // ─── Event Log Cmdlets ────────────────────────────────────────

    // Get-EventLog
    if (cmdLower === 'get-eventlog') {
      return this.handleGetEventLog(args);
    }

    // Write-EventLog
    if (cmdLower === 'write-eventlog') {
      return this.handleWriteEventLog(args);
    }

    // Clear-EventLog
    if (cmdLower === 'clear-eventlog') {
      return this.handleClearEventLog(args);
    }

    // New-EventLog
    if (cmdLower === 'new-eventlog') {
      return this.handleNewEventLog(args);
    }

    // Limit-EventLog
    if (cmdLower === 'limit-eventlog') {
      return this.handleLimitEventLog(args);
    }

    // Get-WinEvent
    if (cmdLower === 'get-winevent') {
      return this.handleGetWinEvent(args);
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
      return args.join(' ').replace(/^["']|["']$/g, '');
    }

    // Clear-Host / cls / clear
    if (cmdLower === 'clear-host' || cmdLower === 'cls' || cmdLower === 'clear') {
      return ''; // Screen clear is handled by the sub-shell, executor returns empty string
    }

    // Get-Process / gps / ps
    if (cmdLower === 'get-process' || cmdLower === 'gps') {
      return psGetProcess(this.buildPSProcessCtx(), args);
    }

    // Stop-Process / spps / kill
    if (cmdLower === 'stop-process' || cmdLower === 'spps' || cmdLower === 'kill') {
      return psStopProcess(this.buildPSProcessCtx(), args);
    }

    // Get-Help / man / help
    if (cmdLower === 'get-help' || cmdLower === 'man' || cmdLower === 'help') {
      let topic = '';
      let category = '', paramName = '', component = '', role = '', functionality = '';
      let examples = false, detailed = false, full = false, online = false, showWindow = false;
      for (let i = 0; i < args.length; i++) {
        const al = args[i].toLowerCase();
        if ((al === '-name') && args[i+1]) { topic = args[++i].replace(/^["']|["']$/g, ''); }
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
      return this.formatGetHelp(topic || undefined, helpOpts);
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
      return this.handleGetNetIPConfiguration(args);
    }

    // Get-NetIPAddress
    if (cmdLower === 'get-netipaddress') {
      return this.handleGetNetIPAddress(args);
    }

    // New-NetIPAddress
    if (cmdLower === 'new-netipaddress') {
      return this.handleNewNetIPAddress(args);
    }

    // Remove-NetIPAddress
    if (cmdLower === 'remove-netipaddress') {
      return this.handleRemoveNetIPAddress(args);
    }

    // Set-NetIPAddress
    if (cmdLower === 'set-netipaddress') {
      return this.handleSetNetIPAddress(args);
    }

    // Get-NetRoute
    if (cmdLower === 'get-netroute') {
      return this.handleGetNetRoute(args);
    }

    // New-NetRoute
    if (cmdLower === 'new-netroute') {
      return this.handleNewNetRoute(args);
    }

    // Remove-NetRoute
    if (cmdLower === 'remove-netroute') {
      return this.handleRemoveNetRoute(args);
    }

    // Get-DnsClientServerAddress
    if (cmdLower === 'get-dnsclientserveraddress') {
      return this.handleGetDnsClientServerAddress(args);
    }

    // Set-DnsClientServerAddress
    if (cmdLower === 'set-dnsclientserveraddress') {
      return this.handleSetDnsClientServerAddress(args);
    }

    // Get-NetAdapter
    if (cmdLower === 'get-netadapter') {
      return this.handleGetNetAdapter(args);
    }

    // Test-Connection (PowerShell ping)
    if (cmdLower === 'test-connection') {
      return this.handleTestConnection(args);
    }

    // Get-NetTCPConnection (simulated netstat-like)
    if (cmdLower === 'get-nettcpconnection') {
      return this.formatGetNetTCPConnection(args);
    }

    // Get-NetFirewallRule
    if (cmdLower === 'get-netfirewallrule') {
      return this.formatGetNetFirewallRule(args);
    }

    // Resolve-DnsName
    if (cmdLower === 'resolve-dnsname') {
      const target = args.find(a => !a.startsWith('-')) ?? '';
      if (target.toLowerCase() === 'localhost' || target === '127.0.0.1') {
        return `\nName                                           Type   TTL   Section    IPAddress\n----                                           ----   ---   -------    ---------\nlocalhost                                      A      86400 Answer     127.0.0.1\n`;
      }
      return `\nName   : ${target}\nType   : A\nTTL    : 3600\nSection: Answer\nIPAddress: 192.168.1.1\n`;
    }

    // Get-Disk
    if (cmdLower === 'get-disk') {
      return this.handleGetDisk(args);
    }

    // Get-Volume
    if (cmdLower === 'get-volume') {
      return this.handleGetVolume(args);
    }

    // Get-ScheduledTask
    if (cmdLower === 'get-scheduledtask') {
      const nameParam = args.find((a, i) => args[i - 1]?.toLowerCase() === '-taskname') || args.find(a => !a.startsWith('-'));
      const tasks = [
        { TaskName: 'GoogleUpdateTaskUser', TaskPath: '\\', State: 'Ready' },
        { TaskName: 'OneDrive Standalone Update Task', TaskPath: '\\', State: 'Ready' },
        { TaskName: '.NET Framework NGEN v4.0.30319', TaskPath: '\\Microsoft\\Windows\\.NET', State: 'Ready' },
        { TaskName: 'SimTestTask', TaskPath: '\\', State: 'Ready' },
      ];
      const filtered = nameParam ? tasks.filter(t => t.TaskName.toLowerCase().includes(nameParam.toLowerCase())) : tasks;
      const lines = ['', 'TaskPath                          TaskName                        State    ', '--------                          --------                        -----    '];
      for (const t of filtered) {
        lines.push(`${t.TaskPath.padEnd(34)}${t.TaskName.padEnd(32)}${t.State}`);
      }
      return lines.join('\n');
    }

    // Register-ScheduledTask
    if (cmdLower === 'register-scheduledtask') {
      const nameIdx = args.findIndex(a => a.toLowerCase() === '-taskname');
      const name = nameIdx >= 0 ? args[nameIdx + 1]?.replace(/^["']|["']$/g, '') : 'Task';
      return `\n\\${name}\n`;
    }

    // New-ScheduledTaskAction / New-ScheduledTaskTrigger
    if (cmdLower === 'new-scheduledtaskaction' || cmdLower === 'new-scheduledtasktrigger') {
      return '';
    }

    // Unregister-ScheduledTask
    if (cmdLower === 'unregister-scheduledtask') {
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

    // Get-Date
    if (cmdLower === 'get-date') {
      return new Date().toString();
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

    // Native commands that work in both CMD and PS
    if (['ipconfig', 'ping', 'netsh', 'tracert', 'route', 'arp', 'systeminfo', 'ver',
         'tasklist', 'taskkill', 'sc', 'sc.exe'].includes(cmdLower)) {
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
      return this.handleTestPath(args);
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
      return this.handleResolvePath(args);
    }

    // Split-Path
    if (cmdLower === 'split-path') {
      return this.handleSplitPath(args);
    }

    // Join-Path
    if (cmdLower === 'join-path') {
      return this.handleJoinPath(args);
    }

    // ─── User/Group/ACL Management Cmdlets ──────────────────────

    // whoami (also works in PS)
    if (cmdLower === 'whoami') {
      return await this.device.executeCmdCommand('whoami ' + args.join(' '));
    }

    // Get-LocalUser
    if (cmdLower === 'get-localuser') {
      return this.handleGetLocalUser(args);
    }

    // New-LocalUser
    if (cmdLower === 'new-localuser') {
      return this.handleNewLocalUser(args);
    }

    // Set-LocalUser
    if (cmdLower === 'set-localuser') {
      return this.handleSetLocalUser(args);
    }

    // Remove-LocalUser
    if (cmdLower === 'remove-localuser') {
      return this.handleRemoveLocalUser(args);
    }

    // Enable-LocalUser
    if (cmdLower === 'enable-localuser') {
      return this.handleEnableLocalUser(args);
    }

    // Disable-LocalUser
    if (cmdLower === 'disable-localuser') {
      return this.handleDisableLocalUser(args);
    }

    // Get-LocalGroup
    if (cmdLower === 'get-localgroup') {
      return this.handleGetLocalGroup(args);
    }

    // New-LocalGroup
    if (cmdLower === 'new-localgroup') {
      return this.handleNewLocalGroup(args);
    }

    // Remove-LocalGroup
    if (cmdLower === 'remove-localgroup') {
      return this.handleRemoveLocalGroup(args);
    }

    // Add-LocalGroupMember
    if (cmdLower === 'add-localgroupmember') {
      return this.handleAddLocalGroupMember(args);
    }

    // Remove-LocalGroupMember
    if (cmdLower === 'remove-localgroupmember') {
      return this.handleRemoveLocalGroupMember(args);
    }

    // Get-LocalGroupMember
    if (cmdLower === 'get-localgroupmember') {
      return this.handleGetLocalGroupMember(args);
    }

    // Get-Acl
    if (cmdLower === 'get-acl') {
      return this.handleGetAcl(args);
    }

    // Rename-LocalUser
    if (cmdLower === 'rename-localuser') {
      return this.handleRenameLocalUser(args);
    }

    // Rename-LocalGroup
    if (cmdLower === 'rename-localgroup') {
      return this.handleRenameLocalGroup(args);
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
    const currentUser = this.device.getUserManager().currentUser;
    const u = currentUser || 'User';
    const envMap: Record<string, string> = {
      'USERNAME':               u,
      'COMPUTERNAME':           this.device.getHostname(),
      'USERPROFILE':            `C:\\Users\\${u}`,
      'SYSTEMROOT':             'C:\\Windows',
      'WINDIR':                 'C:\\Windows',
      'TEMP':                   `C:\\Users\\${u}\\AppData\\Local\\Temp`,
      'TMP':                    `C:\\Users\\${u}\\AppData\\Local\\Temp`,
      'PATH':                   'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      'HOMEDRIVE':              'C:',
      'HOMEPATH':               `\\Users\\${u}`,
      'PROCESSOR_ARCHITECTURE': 'AMD64',
      'OS':                     'Windows_NT',
      'COMSPEC':                'C:\\Windows\\System32\\cmd.exe',
      'PSMODULEPATH':           `C:\\Users\\${u}\\Documents\\WindowsPowerShell\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules`,
      // Phase 8 additions
      'APPDATA':                `C:\\Users\\${u}\\AppData\\Roaming`,
      'LOCALAPPDATA':           `C:\\Users\\${u}\\AppData\\Local`,
      'PROGRAMFILES':           'C:\\Program Files',
      'PROGRAMFILES(X86)':      'C:\\Program Files (x86)',
      'PROGRAMDATA':            'C:\\ProgramData',
      'PATHEXT':                '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1',
      'NUMBER_OF_PROCESSORS':   '4',
      'USERDOMAIN':             'WORKGROUP',
      'LOGONSERVER':            `\\\\${this.device.getHostname()}`,
      'SESSIONNAME':            'Console',
      'SYSTEMDRIVE':            'C:',
      'PUBLIC':                 'C:\\Users\\Public',
      'ALLUSERSPROFILE':        'C:\\ProgramData',
    };
    return envMap[varName.toUpperCase()] ?? null;
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
      if (stack.length === 0) return '';
      return stack.map(p => `\nPath\n----\n${p}\n`).join('\n');
    }

    if (stackFlag) {
      const stack = this.locationStack.get('default') ?? [];
      if (stack.length === 0) return '';
      return stack.map(p => `\nPath\n----\n${p}\n`).join('\n');
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
        const stripped = raw.replace(/^["']|["']$/g, '');
        const items = this.tryParseArrayLiteral(stripped);
        value = items ? items.join(noNewline ? '' : '\n') : stripped;
      }
      else if (!args[i].startsWith('-')) {
        const raw = args[i];
        // Try array parse BEFORE stripping quotes (to handle "a","b" correctly)
        const items = this.tryParseArrayLiteral(raw);
        if (items) { positionals.push(...items); }
        else { positionals.push(raw.replace(/^["']|["']$/g, '')); }
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

  private handleGetItemProperty(args: string[]): string {
    let path = '', name = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-Path' && args[i + 1]) { path = args[++i]; }
      else if (args[i] === '-Name' && args[i + 1]) { name = args[++i]; }
      else if (!args[i].startsWith('-') && !path) { path = args[i]; }
      else if (!args[i].startsWith('-') && path && !name) { name = args[i]; }
    }
    if (!path) return "Get-ItemProperty : Cannot bind argument to parameter 'Path' because it is an empty string.";
    if (!isRegistryPath(path)) return `Get-ItemProperty : Cannot find path '${path}' because it does not exist.`;
    return this.registry.getItemProperty(path, name || undefined);
  }

  private handleSetItemProperty(args: string[]): string {
    let path = '', name = '', value: string | number = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-Path' && args[i + 1]) { path = args[++i]; }
      else if (args[i] === '-Name' && args[i + 1]) { name = args[++i]; }
      else if (args[i] === '-Value' && args[i + 1]) {
        const raw = args[++i].replace(/^["']|["']$/g, '');
        // Only treat as integer if it's a bare integer literal (no quotes, no decimal)
        value = /^-?\d+$/.test(raw) ? Number(raw) : raw;
      }
    }
    if (!path) return "Set-ItemProperty : Cannot bind argument to parameter 'Path' because it is an empty string.";
    if (!isRegistryPath(path)) return `Set-ItemProperty : Cannot find path '${path}' because it does not exist.`;
    return this.registry.setItemProperty(path, name, value);
  }

  private handleRemoveItemProperty(args: string[]): string {
    let path = '', name = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-Path' && args[i + 1]) { path = args[++i]; }
      else if (args[i] === '-Name' && args[i + 1]) { name = args[++i]; }
    }
    if (!path) return "Remove-ItemProperty : Cannot bind argument to parameter 'Path' because it is an empty string.";
    if (!isRegistryPath(path)) return `Remove-ItemProperty : Cannot find path '${path}' because it does not exist.`;
    return this.registry.removeItemProperty(path, name);
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

    // If path is a file (not a directory), show just the file
    const pathEntry = fs.resolve(absPath);
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
    const lines: string[] = ['', 'Name                           Value', '----                           -----'];
    const envVars: Record<string, string> = {
      'Path': this.resolveEnvVar('PATH') ?? '',
      'SystemRoot': 'C:\\Windows',
      'TEMP': this.resolveEnvVar('TEMP') ?? '',
      'USERNAME': this.resolveEnvVar('USERNAME') ?? '',
      'COMPUTERNAME': this.resolveEnvVar('COMPUTERNAME') ?? '',
      'OS': 'Windows_NT',
      'PROCESSOR_ARCHITECTURE': 'AMD64',
      'USERPROFILE': this.resolveEnvVar('USERPROFILE') ?? '',
      'APPDATA': this.resolveEnvVar('APPDATA') ?? '',
      'LOCALAPPDATA': this.resolveEnvVar('LOCALAPPDATA') ?? '',
      'PROGRAMFILES': 'C:\\Program Files',
      'WINDIR': 'C:\\Windows',
      'SYSTEMDRIVE': 'C:',
    };
    // Include session overrides
    for (const [k, v] of this.sessionEnv.entries()) {
      envVars[k] = v;
    }
    for (const [k, v] of Object.entries(envVars)) {
      lines.push(`${k.padEnd(31)}${v}`);
    }
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

  private handleGetEventLog(args: string[]): string {
    const listFlag = args.some(a => a === '-List' || a.toLowerCase() === '-list');
    if (listFlag) return this.eventLog.getEventLogList();

    let logName = '', newest: number | undefined, entryType = '', source = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-LogName' && args[i + 1]) { logName = args[++i]; }
      else if (a === '-Newest' && args[i + 1]) { newest = parseInt(args[++i], 10); }
      else if (a === '-EntryType' && args[i + 1]) { entryType = args[++i]; }
      else if (a === '-Source' && args[i + 1]) { source = args[++i]; }
      else if (!a.startsWith('-') && !logName) { logName = a; }
    }
    if (!logName) return "Get-EventLog : Cannot bind argument to parameter 'LogName' because it is null.";
    return this.eventLog.getEventLog(logName, { newest, entryType: entryType || undefined, source: source || undefined });
  }

  private handleWriteEventLog(args: string[]): string {
    let logName = '', source = '', message = '', entryType: EntryType = 'Information';
    let eventId = 0;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-LogName' && args[i + 1]) { logName = args[++i]; }
      else if (a === '-Source' && args[i + 1]) { source = args[++i].replace(/^['"]|['"]$/g, ''); }
      else if (a === '-Message' && args[i + 1]) { message = args[++i].replace(/^['"]|['"]$/g, ''); }
      else if (a === '-EventId' && args[i + 1]) { eventId = parseInt(args[++i], 10); }
      else if (a === '-EntryType' && args[i + 1]) { entryType = args[++i] as EntryType; }
    }
    if (!logName || !source || !eventId) {
      return "Write-EventLog : -LogName, -Source, and -EventId are required parameters.";
    }
    return this.eventLog.writeEventLog(logName, source, eventId, entryType, message);
  }

  private handleClearEventLog(args: string[]): string {
    let logName = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-LogName' && args[i + 1]) { logName = args[++i]; }
      else if (!args[i].startsWith('-') && !logName) { logName = args[i]; }
    }
    if (!logName) return "Clear-EventLog : -LogName is required.";
    return this.eventLog.clearEventLog(logName);
  }

  private handleNewEventLog(args: string[]): string {
    let logName = '', source = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-LogName' && args[i + 1]) { logName = args[++i]; }
      else if (args[i] === '-Source' && args[i + 1]) { source = args[++i].replace(/^['"]|['"]$/g, ''); }
    }
    if (!logName) return "New-EventLog : -LogName is required.";
    return this.eventLog.newEventLog(logName, source);
  }

  private handleLimitEventLog(args: string[]): string {
    let logName = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-LogName' && args[i + 1]) { logName = args[++i]; }
      else if (!args[i].startsWith('-') && !logName) { logName = args[i]; }
    }
    if (!logName) return '';
    return this.eventLog.limitEventLog(logName);
  }

  private handleGetWinEvent(args: string[]): string {
    const listLogFlag = args.some(a => a === '-ListLog');
    if (listLogFlag) return this.eventLog.getWinEventList();

    let logName = '', maxEvents: number | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-LogName' && args[i + 1]) { logName = args[++i]; }
      else if (a === '-MaxEvents' && args[i + 1]) { maxEvents = parseInt(args[++i], 10); }
      else if (!a.startsWith('-') && !logName) { logName = a; }
    }
    if (!logName) return "Get-WinEvent : -LogName is required.";
    return this.eventLog.getWinEvent(logName, maxEvents);
  }

  // ─── Connection Handlers ──────────────────────────────────────────

  private async handleTestConnection(args: string[]): Promise<string> {
    let target = '', count = '4';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-ComputerName' && args[i + 1]) { target = args[++i]; }
      else if (args[i] === '-Count' && args[i + 1]) { count = args[++i]; }
      else if (!args[i].startsWith('-')) { target = args[i]; }
    }
    if (!target) return "Test-Connection : Parameter 'ComputerName' is required.";

    // Execute the underlying ping to get results
    const pingOutput = await this.device.executeCmdCommand(`ping -n ${count} ${target}`);

    // Transform CMD ping output to PS Test-Connection table format
    return this.formatTestConnection(pingOutput, target);
  }

  private formatTestConnection(pingOutput: string, target: string): string {
    const lines: string[] = [];
    const source = String(this.device.getHostname());

    // Parse Reply lines from CMD ping output
    const replyLines = pingOutput.split('\n').filter(l => l.trim().startsWith('Reply from'));
    const timeoutLines = pingOutput.split('\n').filter(l => l.trim() === 'Request timed out.');

    const isLocalhost = target === 'localhost' || target === '127.0.0.1' || target.toLowerCase() === this.device.getHostname().toLowerCase();

    if (replyLines.length === 0 && !isLocalhost) {
      return `Test-Connection : Testing connection to computer '${target}' failed: host unreachable.\n    + CategoryInfo          : ResourceUnavailable: (${target}:String) [Test-Connection], PingException\n    + FullyQualifiedErrorId : TestConnectionException,Microsoft.PowerShell.Commands.TestConnectionCommand`;
    }

    lines.push('Source           Destination       IPV4Address      Bytes    Time(ms) Status');
    lines.push('------           -----------       -----------      -----    -------- ------');

    const effectiveReplies = isLocalhost && replyLines.length === 0
      ? ['Reply from 127.0.0.1: bytes=32 time<1ms TTL=128']
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

  private formatGetHelp(topic?: string, opts?: { examples?: boolean; detailed?: boolean; full?: boolean; parameter?: string; online?: boolean; showWindow?: boolean; category?: string; component?: string; role?: string; functionality?: string }): string {
    const helpDb: Record<string, { synopsis: string; description: string; syntax: string; examples?: string; parameters?: string }> = {
      'clear-host': {
        synopsis: 'Clears the display in the host program.',
        description: 'The Clear-Host cmdlet deletes the current text from the display, including commands and any output that might have accumulated.',
        syntax: 'Clear-Host [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Clear-Host\n    (Screen is cleared)',
        parameters: '-WhatIf, -Confirm, -Verbose',
      },
      'copy-item': {
        synopsis: 'Copies an item from one location to another.',
        description: 'The Copy-Item cmdlet copies an item from one location to another location in the same namespace.',
        syntax: 'Copy-Item [-Path] <String[]> [[-Destination] <String>] [-Recurse] [-Force] [-Filter <String>] [-Include <String[]>] [-Exclude <String[]>] [-LiteralPath <String[]>] [-PassThru] [-Container] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Copy-Item C:\\source.txt C:\\dest.txt',
        parameters: '-Path, -Destination, -Recurse, -Force, -Filter, -Include, -Exclude, -LiteralPath, -PassThru, -Container',
      },
      'get-childitem': {
        synopsis: 'Gets the items and child items in one or more specified locations.',
        description: 'The Get-ChildItem cmdlet gets the items in one or more specified locations. If the item is a container, it gets the items inside the container.',
        syntax: 'Get-ChildItem [[-Path] <String[]>] [-Filter <String>] [-Include <String[]>] [-Exclude <String[]>] [-Recurse] [-Depth <UInt32>] [-Name] [-Directory] [-File] [-Hidden] [-System] [-Force] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-ChildItem C:\\',
        parameters: '-Path, -Filter, -Include, -Exclude, -Recurse, -Depth, -Name, -Directory, -File, -Hidden, -System, -Force',
      },
      'get-command': {
        synopsis: 'Gets all commands.',
        description: 'The Get-Command cmdlet gets all commands that are installed on the computer.',
        syntax: 'Get-Command [[-Name] <String[]>] [-CommandType <CommandTypes>] [-Module <String[]>] [-Noun <String>] [-Verb <String>] [-All] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-Command\n    (Lists all available commands)',
        parameters: '-Name, -CommandType, -Module, -Noun, -Verb, -All',
      },
      'get-content': {
        synopsis: 'Gets the content of the item at the specified location.',
        description: 'The Get-Content cmdlet gets the content of the item at the location specified by the path.',
        syntax: 'Get-Content [-Path] <String[]> [-TotalCount <Int64>] [-Tail <Int32>] [-Raw] [-AsByteStream] [-Stream <String>] [-Wait] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-Content C:\\file.txt',
        parameters: '-Path, -LiteralPath, -TotalCount, -Tail, -Raw, -AsByteStream, -Stream, -Wait, -First, -Last',
      },
      'get-help': {
        synopsis: 'Displays information about Windows PowerShell commands and concepts.',
        description: 'The Get-Help cmdlet displays information about PowerShell concepts and commands.',
        syntax: 'Get-Help [[-Name] <String>] [-Full] [-Detailed] [-Examples] [-Online] [-Parameter <String>] [-Category <String>] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-Help Get-Process',
        parameters: '-Name, -Full, -Detailed, -Examples, -Online, -Parameter, -Category, -Component, -Role, -Functionality',
      },
      'get-location': {
        synopsis: 'Gets information about the current working location or a location stack.',
        description: 'The Get-Location cmdlet gets an object that represents the current directory.',
        syntax: 'Get-Location [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-Location\n    Path\n    ----\n    C:\\Users\\User',
        parameters: '-Stack, -StackName',
      },
      'get-netadapter': {
        synopsis: 'Gets the basic network adapter properties.',
        description: 'The Get-NetAdapter cmdlet gets the basic network adapter properties, including the name, interface description, interface index, and MAC address.',
        syntax: 'Get-NetAdapter [[-Name] <String[]>] [-Physical] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-NetAdapter',
        parameters: '-Name, -Physical, -IncludeHidden, -All',
      },
      'get-netipaddress': {
        synopsis: 'Gets the IP address configuration.',
        description: 'The Get-NetIPAddress cmdlet gets the IP address configuration for the specified interface.',
        syntax: 'Get-NetIPAddress [[-IPAddress] <String[]>] [-InterfaceAlias <String[]>] [-AddressFamily <AddressFamily>] [-PrefixLength <Byte>] [-AddressState <AddressState>] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-NetIPAddress\n    (Lists all IP addresses)',
        parameters: '-IPAddress, -InterfaceAlias, -InterfaceIndex, -AddressFamily, -PrefixLength, -AddressState, -PrefixOrigin, -SuffixOrigin',
      },
      'new-netipaddress': {
        synopsis: 'Creates and configures an IP address.',
        description: 'The New-NetIPAddress cmdlet creates and configures an IP address and related settings.',
        syntax: 'New-NetIPAddress [-IPAddress] <String> -InterfaceAlias <String> -PrefixLength <Byte> [-DefaultGateway <String>] [-AddressFamily <AddressFamily>] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.1.10 -PrefixLength 24',
        parameters: '-IPAddress, -InterfaceAlias, -InterfaceIndex, -PrefixLength, -DefaultGateway, -AddressFamily, -SkipAsSource',
      },
      'remove-netipaddress': {
        synopsis: 'Removes an IP address and its configuration.',
        description: 'The Remove-NetIPAddress cmdlet removes an IP address and its related settings.',
        syntax: 'Remove-NetIPAddress [[-IPAddress] <String[]>] [-InterfaceAlias <String[]>] [-AddressFamily <AddressFamily>] [-Confirm:$false] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Remove-NetIPAddress -IPAddress 192.168.1.10 -Confirm:$false',
        parameters: '-IPAddress, -InterfaceAlias, -AddressFamily, -Confirm',
      },
      'set-netipaddress': {
        synopsis: 'Modifies the configuration of an IP address.',
        description: 'The Set-NetIPAddress cmdlet modifies the configuration of an IP address.',
        syntax: 'Set-NetIPAddress [[-IPAddress] <String[]>] [-PrefixLength <Byte>] [-PrefixOrigin <PrefixOrigin>] [-SkipAsSource <Boolean>] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Set-NetIPAddress -IPAddress 192.168.1.10 -PrefixLength 16',
        parameters: '-IPAddress, -PrefixLength, -PrefixOrigin, -SuffixOrigin, -SkipAsSource',
      },
      'get-netipconfiguration': {
        synopsis: 'Gets IP network configuration.',
        description: 'The Get-NetIPConfiguration cmdlet gets network configuration including adapter, IP address, and DNS server information.',
        syntax: 'Get-NetIPConfiguration [[-InterfaceAlias] <String>] [-All] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-NetIPConfiguration',
        parameters: '-InterfaceAlias, -InterfaceIndex, -All',
      },
      'get-netroute': {
        synopsis: 'Gets the IP route information from the IP routing table.',
        description: 'The Get-NetRoute cmdlet gets the IP route information from the IP routing table.',
        syntax: 'Get-NetRoute [[-DestinationPrefix] <String[]>] [-InterfaceAlias <String[]>] [-NextHop <String[]>] [-RouteMetric <UInt16>] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-NetRoute\n    (Lists routing table)',
        parameters: '-DestinationPrefix, -InterfaceAlias, -NextHop, -RouteMetric, -AddressFamily',
      },
      'new-netroute': {
        synopsis: 'Creates a route in the IP routing table.',
        description: 'The New-NetRoute cmdlet creates a route in the IP routing table.',
        syntax: 'New-NetRoute -DestinationPrefix <String> -InterfaceAlias <String> [-NextHop <String>] [-RouteMetric <UInt16>] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> New-NetRoute -DestinationPrefix "10.0.0.0/8" -InterfaceAlias "Ethernet" -NextHop 192.168.1.1',
        parameters: '-DestinationPrefix, -InterfaceAlias, -NextHop, -RouteMetric, -PolicyStore',
      },
      'remove-netroute': {
        synopsis: 'Removes IP routes from the IP routing table.',
        description: 'The Remove-NetRoute cmdlet removes IP routes from the IP routing table.',
        syntax: 'Remove-NetRoute [[-DestinationPrefix] <String[]>] [-InterfaceAlias <String[]>] [-NextHop <String[]>] [-Confirm:$false] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Remove-NetRoute -DestinationPrefix "10.0.0.0/8" -Confirm:$false',
        parameters: '-DestinationPrefix, -InterfaceAlias, -NextHop, -Confirm',
      },
      'get-dnsclientserveraddress': {
        synopsis: 'Gets the DNS server IP addresses from the TCP/IP properties on an interface.',
        description: 'The Get-DnsClientServerAddress cmdlet gets the DNS server IP addresses from the TCP/IP properties on an interface.',
        syntax: 'Get-DnsClientServerAddress [[-InterfaceAlias] <String[]>] [-AddressFamily <AddressFamily>] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-DnsClientServerAddress -InterfaceAlias "Ethernet"',
        parameters: '-InterfaceAlias, -InterfaceIndex, -AddressFamily',
      },
      'set-dnsclientserveraddress': {
        synopsis: 'Sets the DNS server IP addresses for a network interface.',
        description: 'The Set-DnsClientServerAddress cmdlet sets one or more IP addresses for DNS servers associated with the specified interface.',
        syntax: 'Set-DnsClientServerAddress -InterfaceAlias <String> -ServerAddresses <String[]> [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses "8.8.8.8","8.8.4.4"',
        parameters: '-InterfaceAlias, -InterfaceIndex, -ServerAddresses, -ResetServerAddresses',
      },
      'get-process': {
        synopsis: 'Gets the processes that are running on the local computer.',
        description: 'The Get-Process cmdlet gets the processes that are running on the local computer.',
        syntax: 'Get-Process [[-Name] <String[]>] [-Id <Int32[]>] [-ComputerName <String[]>] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-Process\n    (Lists all processes)',
        parameters: '-Name, -Id, -ComputerName, -IncludeUserName, -Module, -FileVersionInfo',
      },
      'stop-process': {
        synopsis: 'Stops one or more running processes.',
        description: 'The Stop-Process cmdlet stops one or more running processes.',
        syntax: 'Stop-Process [-Id] <Int32[]> [-Force] [<CommonParameters>]\nStop-Process -Name <String[]> [-Force] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Stop-Process -Name "notepad"',
        parameters: '-Id, -Name, -Force, -PassThru, -WhatIf',
      },
      'get-service': {
        synopsis: 'Gets the services on a local or remote computer.',
        description: 'The Get-Service cmdlet gets objects that represent the services on a local computer.',
        syntax: 'Get-Service [[-Name] <String[]>] [-DisplayName <String[]>] [-DependentServices] [-RequiredServices] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-Service\n    (Lists all services)',
        parameters: '-Name, -DisplayName, -Include, -Exclude, -DependentServices, -RequiredServices',
      },
      'move-item': {
        synopsis: 'Moves an item from one location to another.',
        description: 'The Move-Item cmdlet moves an item from one location to another.',
        syntax: 'Move-Item [-Path] <String[]> [[-Destination] <String>] [-Force] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Move-Item C:\\source.txt C:\\dest.txt',
        parameters: '-Path, -Destination, -Force, -Filter, -Include, -Exclude, -LiteralPath, -PassThru',
      },
      'new-item': {
        synopsis: 'Creates a new item.',
        description: 'The New-Item cmdlet creates a new item. The type of item that is created depends on the location.',
        syntax: 'New-Item [-Path] <String[]> [-ItemType <String>] [-Value <Object>] [-Force] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> New-Item -Path C:\\newdir -ItemType Directory',
        parameters: '-Path, -Name, -ItemType, -Value, -Force',
      },
      'remove-item': {
        synopsis: 'Deletes the specified items.',
        description: 'The Remove-Item cmdlet deletes one or more items.',
        syntax: 'Remove-Item [-Path] <String[]> [-Recurse] [-Force] [-Filter <String>] [-Include <String[]>] [-Exclude <String[]>] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Remove-Item C:\\oldfile.txt',
        parameters: '-Path, -Recurse, -Force, -Filter, -Include, -Exclude, -WhatIf',
      },
      'rename-item': {
        synopsis: 'Renames an item in a PowerShell provider namespace.',
        description: 'The Rename-Item cmdlet changes the name of a specified item.',
        syntax: 'Rename-Item [-Path] <String> [-NewName] <String> [-Force] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Rename-Item -Path C:\\old.txt -NewName new.txt',
        parameters: '-Path, -LiteralPath, -NewName, -Force, -PassThru',
      },
      'set-content': {
        synopsis: 'Writes new content or replaces existing content in a file.',
        description: 'The Set-Content cmdlet is a string-processing cmdlet that writes new content or replaces existing content in a file.',
        syntax: 'Set-Content [-Path] <String[]> [-Value] <Object[]> [-Force] [-NoNewline] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Set-Content -Path C:\\file.txt -Value "Hello World"',
        parameters: '-Path, -LiteralPath, -Value, -Force, -NoNewline, -Encoding',
      },
      'set-location': {
        synopsis: 'Sets the current working location to a specified location.',
        description: 'The Set-Location cmdlet sets the working location to a specified location.',
        syntax: 'Set-Location [[-Path] <String>] [-LiteralPath <String>] [-PassThru] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Set-Location C:\\Windows',
        parameters: '-Path, -LiteralPath, -PassThru, -Stack, -StackName',
      },
      'test-connection': {
        synopsis: 'Sends ICMP echo request packets (pings) to one or more computers.',
        description: 'The Test-Connection cmdlet sends Internet Control Message Protocol (ICMP) echo request packets to one or more remote computers.',
        syntax: 'Test-Connection [-ComputerName] <String[]> [-Count <Int32>] [-Delay <Int32>] [-Quiet] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Test-Connection -ComputerName 8.8.8.8',
        parameters: '-ComputerName, -Count, -Delay, -BufferSize, -Quiet, -TTL, -DontFragment',
      },
      'write-host': {
        synopsis: 'Writes customized output to a host.',
        description: 'The Write-Host cmdlet writes output to the host. It bypasses the output stream.',
        syntax: 'Write-Host [[-Object] <Object>] [-NoNewline] [-Separator <Object>] [-ForegroundColor <ConsoleColor>] [-BackgroundColor <ConsoleColor>] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Write-Host "Hello World" -ForegroundColor Green',
        parameters: '-Object, -NoNewline, -Separator, -ForegroundColor, -BackgroundColor',
      },
      'write-output': {
        synopsis: 'Sends the specified objects to the next command in the pipeline.',
        description: 'The Write-Output cmdlet sends the specified objects to the next command in the pipeline.',
        syntax: 'Write-Output [-InputObject] <PSObject[]> [-NoEnumerate] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Write-Output "Hello"',
        parameters: '-InputObject, -NoEnumerate',
      },
      'get-disk': {
        synopsis: 'Gets one or more disks visible to the operating system.',
        description: 'The Get-Disk cmdlet gets one or more disks visible to the operating system.',
        syntax: 'Get-Disk [[-Number] <UInt32[]>] [-FriendlyName <String[]>] [-SerialNumber <String[]>] [-UniqueId <String[]>] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-Disk\n    (Lists all disks)',
        parameters: '-Number, -FriendlyName, -SerialNumber, -UniqueId',
      },
      'get-volume': {
        synopsis: 'Gets the specified Volume object, or all Volume objects if no filter is specified.',
        description: 'The Get-Volume cmdlet returns a list of all available volumes.',
        syntax: 'Get-Volume [[-DriveLetter] <Char[]>] [-FriendlyName <String[]>] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-Volume\n    (Lists all volumes)',
        parameters: '-DriveLetter, -FriendlyName, -FileSystemLabel',
      },
      'get-localuser': {
        synopsis: 'Gets local user accounts.',
        description: 'The Get-LocalUser cmdlet gets local user accounts.',
        syntax: 'Get-LocalUser [[-Name] <String[]>] [-SID <SecurityIdentifier[]>] [<CommonParameters>]',
        examples: 'EXAMPLE 1\n    PS> Get-LocalUser\n    (Lists all local users)',
        parameters: '-Name, -SID',
      },
    };

    if (!topic) {
      return [
        'TOPIC',
        '    Windows PowerShell Help System',
        '',
        'SHORT DESCRIPTION',
        '    Displays help about Windows PowerShell cmdlets and concepts.',
        '',
        'LONG DESCRIPTION',
        '    Windows PowerShell Help describes cmdlets, functions, scripts, and modules.',
        '',
        '    To get help for a cmdlet, type: Get-Help <cmdlet-name>',
      ].join('\n');
    }

    const key = topic.toLowerCase().replace(/^["']|["']$/g, '');
    const entry = helpDb[key];

    if (!entry) {
      return [
        'TOPIC',
        '    Windows PowerShell Help System',
        '',
        'SHORT DESCRIPTION',
        '    Displays help about Windows PowerShell cmdlets and concepts.',
        '',
        'LONG DESCRIPTION',
        '    Windows PowerShell Help describes cmdlets, functions, scripts, and modules.',
        '',
        `    To get help for a cmdlet, type: Get-Help <cmdlet-name>`,
        '',
        `Get-Help : No help topic was not found for '${topic}'. Verify that the topic is correct and try the command again.`,
      ].join('\n');
    }

    if (opts?.showWindow) {
      return `Get-Help : The -ShowWindow parameter is not supported in this simulator.\n    Use Get-Help ${topic} to view help in the terminal.`;
    }
    if (opts?.online) {
      return `Opening online help for ${topic}... (simulated: no browser in simulator)`;
    }
    if (opts?.parameter) {
      return `PARAMETER: -${opts.parameter}\n\nName: -${opts.parameter}\n    ${entry.parameters ?? '(no parameter info)'}`;
    }

    const lines: string[] = [
      `NAME`,
      `    ${topic}`,
      ``,
      `SYNOPSIS`,
      `    ${entry.synopsis}`,
      ``,
      `SYNTAX`,
      `    ${entry.syntax}`,
      ``,
      `DESCRIPTION`,
      `    ${entry.description}`,
    ];

    if (opts?.examples || opts?.detailed || opts?.full) {
      if (entry.examples) {
        lines.push('', 'EXAMPLES', `    ${entry.examples}`);
      }
    }
    if (opts?.detailed || opts?.full) {
      if (entry.parameters) {
        lines.push('', 'PARAMETERS', `    ${entry.parameters}`);
      }
    }
    if (opts?.full) {
      lines.push('', 'INPUTS', `    None. You cannot pipe objects to ${topic}.`);
      lines.push('', 'OUTPUTS', `    System.Object`);
      lines.push('', 'NOTES', `    This is a simulated cmdlet.`);
    }
    lines.push('', 'RELATED LINKS', `    Get-Help ${topic} -Online`);

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
      filtered = filtered.filter(c => c.source.toLowerCase().includes(moduleFilter));
    }

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

    const lines = ['CommandType     Name                                               Version    Source',
                    '-----------     ----                                               -------    ------'];
    for (const c of filtered) {
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

  private handleGetNetIPConfiguration(args: string[]): string {
    const params = this.parsePSArgs(args);
    const ifFilter = (params.get('interfacealias') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '').toLowerCase();
    const detailed = params.has('detailed');
    const all = params.has('all');

    return this.formatGetNetIPConfiguration(ifFilter, detailed, all);
  }

  private formatGetNetIPConfiguration(ifFilter = '', detailed = false, all = false): string {
    const ports = this.device.getPortsMap();
    const lines: string[] = [];
    let idx = 0;
    let found = false;

    const addEntry = (displayName: string, ip: string, mask: string, gw: string, dns: string[]) => {
      if (idx > 0) lines.push('');
      lines.push(`InterfaceAlias       : ${displayName}`);
      lines.push(`InterfaceIndex       : ${idx + 1}`);
      lines.push(`IPv4Address          : ${ip || 'Not configured'}`);
      if (mask) lines.push(`IPv4SubnetMask       : ${mask}`);
      lines.push(`IPv4DefaultGateway   : ${gw}`);
      lines.push(`DNSServer            : ${dns.length > 0 ? dns.join(', ') : ''}`);
      if (detailed) {
        lines.push(`ComputerName         : ${this.device.getHostname?.() ?? 'DESKTOP'}`);
      }
      idx++;
      found = true;
    };

    for (const [name, port] of ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      if (ifFilter && !displayName.toLowerCase().includes(ifFilter) && displayName.toLowerCase() !== ifFilter) continue;
      const ip = port.getIPAddress()?.toString() ?? '';
      const mask = port.getSubnetMask()?.toString() ?? '';
      const gw = this.device.getDefaultGateway() ?? '';
      const dns = this.device.getDnsServers(name);
      addEntry(displayName, ip, mask, gw, dns);
    }

    // Loopback (shown with -All or when specifically requested)
    if (all && (!ifFilter || 'loopback'.includes(ifFilter))) {
      addEntry('Loopback Pseudo-Interface 1', '127.0.0.1', '255.0.0.0', '', []);
    }

    if (!found && ifFilter) {
      return `Get-NetIPConfiguration : Interface '${ifFilter}' not found. No MSFT_NetIPConfiguration objects found.`;
    }

    return lines.join('\n');
  }

  private buildAllIPEntries(): Array<{ ip: string; ifAlias: string; ifIndex: number; addressFamily: string; prefixLength: number; prefixOrigin: string; suffixOrigin: string; addressState: string; skipAsSource: boolean }> {
    const entries: Array<{ ip: string; ifAlias: string; ifIndex: number; addressFamily: string; prefixLength: number; prefixOrigin: string; suffixOrigin: string; addressState: string; skipAsSource: boolean }> = [];
    const ports = this.device.getPortsMap();
    let idx = 2;
    for (const [name, port] of ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      const ip = port.getIPAddress()?.toString() ?? '';
      const mask = port.getSubnetMask()?.toString() ?? '';
      const prefixLength = mask ? this.maskToPrefixLength(mask) : 0;
      const isDhcp = this.device.isDHCPConfigured(name);
      if (ip) {
        entries.push({ ip, ifAlias: displayName, ifIndex: idx, addressFamily: 'IPv4', prefixLength, prefixOrigin: isDhcp ? 'Dhcp' : 'Manual', suffixOrigin: isDhcp ? 'Dhcp' : 'Manual', addressState: 'Preferred', skipAsSource: false });
      }
      // Link-local IPv6
      const macStr = port.getMAC()?.toString() ?? '00:00:00:00:00:00';
      const macParts = macStr.split(':');
      if (macParts.length === 6) {
        const fe80 = `fe80::${macParts[0]}${macParts[1]}:${macParts[2]}ff:fe${macParts[3]}:${macParts[4]}${macParts[5]}`;
        entries.push({ ip: fe80, ifAlias: displayName, ifIndex: idx, addressFamily: 'IPv6', prefixLength: 64, prefixOrigin: 'WellKnown', suffixOrigin: 'Link', addressState: 'Preferred', skipAsSource: false });
      }
      idx++;
    }
    // Extra IPs (added via New-NetIPAddress)
    for (const [ip, info] of this.extraIPs) {
      entries.push({ ip, ifAlias: info.ifAlias, ifIndex: idx++, addressFamily: info.addressFamily, prefixLength: info.prefixLength, prefixOrigin: info.prefixOrigin, suffixOrigin: info.suffixOrigin, addressState: 'Preferred', skipAsSource: info.skipAsSource });
    }
    // Loopback
    entries.push({ ip: '127.0.0.1', ifAlias: 'Loopback Pseudo-Interface 1', ifIndex: 1, addressFamily: 'IPv4', prefixLength: 8, prefixOrigin: 'WellKnown', suffixOrigin: 'WellKnown', addressState: 'Preferred', skipAsSource: false });
    entries.push({ ip: '::1', ifAlias: 'Loopback Pseudo-Interface 1', ifIndex: 1, addressFamily: 'IPv6', prefixLength: 128, prefixOrigin: 'WellKnown', suffixOrigin: 'WellKnown', addressState: 'Preferred', skipAsSource: false });
    return entries;
  }

  private formatIPEntry(e: ReturnType<typeof this.buildAllIPEntries>[0]): string {
    return [
      `IPAddress         : ${e.ip}`,
      `InterfaceIndex    : ${e.ifIndex}`,
      `InterfaceAlias    : ${e.ifAlias}`,
      `AddressFamily     : ${e.addressFamily}`,
      `Type              : Unicast`,
      `PrefixLength      : ${e.prefixLength}`,
      `PrefixOrigin      : ${e.prefixOrigin}`,
      `SuffixOrigin      : ${e.suffixOrigin}`,
      `AddressState      : ${e.addressState}`,
      `SkipAsSource      : ${e.skipAsSource ? 'True' : 'False'}`,
    ].join('\n');
  }

  private handleGetNetIPAddress(args: string[]): string {
    const params = this.parsePSArgs(args);
    const ipFilter = params.get('ipaddress') || params.get('_positional');
    const ifFilter = (params.get('interfacealias') ?? '').toLowerCase().replace(/^["']|["']$/g, '');
    const afFilter = (params.get('addressfamily') ?? '').toLowerCase();
    const plFilter = params.has('prefixlength') ? parseInt(params.get('prefixlength')!, 10) : undefined;
    const stateFilter = (params.get('addressstate') ?? '').toLowerCase();
    const poFilter = (params.get('prefixorigin') ?? '').toLowerCase();
    const soFilter = (params.get('suffixorigin') ?? '').toLowerCase();
    // -IncludeAllCompartments: just ignore in sim
    const errorAction = (params.get('erroraction') ?? '').toLowerCase();

    // Validate explicit IP address filter
    if (ipFilter && !this.isValidIP(ipFilter)) {
      return `Get-NetIPAddress : Invalid IP address: '${ipFilter}'.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    }

    let entries = this.buildAllIPEntries();

    if (ipFilter) entries = entries.filter(e => e.ip.toLowerCase() === ipFilter.toLowerCase());
    if (ifFilter) entries = entries.filter(e => e.ifAlias.toLowerCase().includes(ifFilter) || e.ifAlias.toLowerCase() === ifFilter);
    if (afFilter === 'ipv4') entries = entries.filter(e => e.addressFamily === 'IPv4');
    if (afFilter === 'ipv6') entries = entries.filter(e => e.addressFamily === 'IPv6');
    if (plFilter !== undefined) entries = entries.filter(e => e.prefixLength === plFilter);
    if (stateFilter) entries = entries.filter(e => e.addressState.toLowerCase() === stateFilter);
    if (poFilter) entries = entries.filter(e => e.prefixOrigin.toLowerCase() === poFilter);
    if (soFilter) entries = entries.filter(e => e.suffixOrigin.toLowerCase() === soFilter);

    if (entries.length === 0) {
      if (ifFilter) {
        return `Get-NetIPAddress : No MSFT_NetIPAddress objects found with property 'InterfaceAlias' equal to '${ifFilter}'. Verify the value of the property and retry.`;
      }
      if (ipFilter) {
        return `Get-NetIPAddress : No MSFT_NetIPAddress objects found with property 'IPAddress' equal to '${ipFilter}'. Verify the value of the property and retry.`;
      }
      return '';
    }

    return entries.map(e => this.formatIPEntry(e)).join('\n\n');
  }

  private isValidIP(ip: string): boolean {
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      return ip.split('.').every(p => parseInt(p) <= 255);
    }
    // IPv6 basic check
    if (/^[0-9a-f:]+$/i.test(ip) && ip.includes(':')) return true;
    return false;
  }

  private handleNewNetIPAddress(args: string[]): string {
    const params = this.parsePSArgs(args);
    const ip = params.get('ipaddress') || params.get('_positional');
    const ifAlias = (params.get('interfacealias') ?? '').replace(/^["']|["']$/g, '');
    const prefixStr = params.get('prefixlength');
    const gateway = params.get('defaultgateway');
    const afParam = (params.get('addressfamily') ?? '').toLowerCase();
    const skipAsSource = (params.get('skipassource') ?? '').toLowerCase() === '$true' || params.get('skipassource') === 'true';

    if (!ip) return `New-NetIPAddress : The -IPAddress parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    if (!ifAlias) return `New-NetIPAddress : The -InterfaceAlias parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    if (!prefixStr) return `New-NetIPAddress : The -PrefixLength parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    if (!this.isValidIP(ip)) return `New-NetIPAddress : Invalid IP address: '${ip}'.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;

    const prefixLength = parseInt(prefixStr, 10);
    const isIPv6 = ip.includes(':');
    const maxPrefix = isIPv6 ? 128 : 32;
    if (isNaN(prefixLength) || prefixLength < 0 || prefixLength > maxPrefix) {
      return `New-NetIPAddress : PrefixLength '${prefixStr}' is not in the valid range 0-${maxPrefix}.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    }

    // Check for duplicate
    const existing = this.buildAllIPEntries();
    if (existing.some(e => e.ip.toLowerCase() === ip.toLowerCase())) {
      return `New-NetIPAddress : The IP address '${ip}' already exists on this system.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    }

    const addressFamily = afParam === 'ipv6' || isIPv6 ? 'IPv6' : 'IPv4';
    this.extraIPs.set(ip.toLowerCase(), { ifAlias, prefixLength, prefixOrigin: 'Manual', suffixOrigin: 'Manual', skipAsSource, gateway, addressFamily });

    if (gateway) {
      this.extraRoutes.set('0.0.0.0/0', { ifAlias, nextHop: gateway, metric: 0 });
    }

    return this.formatIPEntry({ ip, ifAlias, ifIndex: 99, addressFamily, prefixLength, prefixOrigin: 'Manual', suffixOrigin: 'Manual', addressState: 'Preferred', skipAsSource });
  }

  private handleRemoveNetIPAddress(args: string[]): string {
    const params = this.parsePSArgs(args);
    const ip = params.get('ipaddress') || params.get('_positional');
    const whatif = params.has('whatif') || args.some(a => a.toLowerCase() === '-whatif');

    if (!ip) return `Remove-NetIPAddress : The -IPAddress parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;

    if (ip === '127.0.0.1' || ip === '::1') {
      return `Remove-NetIPAddress : Cannot remove the loopback address '${ip}'. This address is required for network functionality.`;
    }

    const entries = this.buildAllIPEntries();
    const found = entries.find(e => e.ip.toLowerCase() === ip.toLowerCase());
    if (!found) {
      return `Remove-NetIPAddress : No MSFT_NetIPAddress objects found with property 'IPAddress' equal to '${ip}'. Verify the value of the property and retry.`;
    }

    if (whatif) {
      return `What if: Performing the operation "Remove-NetIPAddress" on target "IPAddress: ${ip}, InterfaceAlias: ${found.ifAlias}".`;
    }

    this.extraIPs.delete(ip.toLowerCase());
    return '';
  }

  private handleSetNetIPAddress(args: string[]): string {
    const params = this.parsePSArgs(args);
    const ip = params.get('ipaddress') || params.get('_positional');

    if (!ip) return `Set-NetIPAddress : The -IPAddress parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;

    const entry = this.extraIPs.get(ip.toLowerCase());
    if (!entry) {
      // Check device IPs
      const all = this.buildAllIPEntries();
      const found = all.find(e => e.ip.toLowerCase() === ip.toLowerCase());
      if (!found) {
        return `Set-NetIPAddress : No MSFT_NetIPAddress objects found with property 'IPAddress' equal to '${ip}'. Verify the value of the property and retry.`;
      }
      // Device-level IPs can't be modified in this sim; add to extraIPs
      this.extraIPs.set(ip.toLowerCase(), { ifAlias: found.ifAlias, prefixLength: found.prefixLength, prefixOrigin: found.prefixOrigin, suffixOrigin: found.suffixOrigin, skipAsSource: found.skipAsSource, addressFamily: found.addressFamily });
    }

    const e = this.extraIPs.get(ip.toLowerCase())!;
    if (params.has('prefixlength')) e.prefixLength = parseInt(params.get('prefixlength')!, 10);
    if (params.has('prefixorigin')) e.prefixOrigin = params.get('prefixorigin')!;
    if (params.has('suffixorigin')) e.suffixOrigin = params.get('suffixorigin')!;
    if (params.has('skipassource')) e.skipAsSource = (params.get('skipassource') ?? '').toLowerCase() !== 'false' && (params.get('skipassource') ?? '') !== '$false';
    return '';
  }

  private buildDefaultRoutes(): Array<{ dest: string; ifAlias: string; nextHop: string; metric: number }> {
    const routes: Array<{ dest: string; ifAlias: string; nextHop: string; metric: number }> = [];
    const gw = this.device.getDefaultGateway();
    const ports = this.device.getPortsMap();
    let firstIF = '';
    for (const [name] of ports) { firstIF = name.replace(/^eth/, 'Ethernet '); break; }
    // Always include default route (with gateway if configured, else 0.0.0.0)
    routes.push({ dest: '0.0.0.0/0', ifAlias: firstIF || 'Ethernet 0', nextHop: gw || '0.0.0.0', metric: 0 });
    // Loopback
    routes.push({ dest: '127.0.0.0/8', ifAlias: 'Loopback Pseudo-Interface 1', nextHop: '0.0.0.0', metric: 306 });
    // Connected network routes
    let idx = 2;
    for (const [name, port] of ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      const ip = port.getIPAddress()?.toString() ?? '';
      const mask = port.getSubnetMask()?.toString() ?? '';
      if (ip && mask) {
        const prefix = this.maskToPrefixLength(mask);
        const network = ip.split('.').map((o, i) => (parseInt(o) & parseInt(mask.split('.')[i])).toString()).join('.');
        routes.push({ dest: `${network}/${prefix}`, ifAlias: displayName, nextHop: '0.0.0.0', metric: 256 });
      }
      idx++;
    }
    // Extra routes
    for (const [dest, info] of this.extraRoutes) {
      routes.push({ dest, ifAlias: info.ifAlias, nextHop: info.nextHop, metric: info.metric });
    }
    return routes;
  }

  private formatRouteEntry(r: { dest: string; ifAlias: string; nextHop: string; metric: number }): string {
    return [
      `ifIndex DestinationPrefix                                                         NextHop                                  RouteMetric ifMetric PolicyStore`,
      `------- -----------------                                                         -------                                  ----------- -------- -----------`,
      `      2 ${r.dest.padEnd(73)}${r.nextHop.padEnd(41)}${String(r.metric).padEnd(12)}256 ActiveStore`,
    ].join('\n') + `\n\nDestinationPrefix : ${r.dest}\nNextHop           : ${r.nextHop}\nRouteMetric       : ${r.metric}\nInterfaceAlias    : ${r.ifAlias}\nInterfaceIndex    : 2\nAddressFamily     : IPv4\nPublish           : No\nPreferredLifetime : 10675199.02:48:05.4775807`;
  }

  private handleGetNetRoute(args: string[]): string {
    const params = this.parsePSArgs(args);
    const destFilter = (params.get('destinationprefix') ?? '').replace(/^["']|["']$/g, '');
    const ifFilter = (params.get('interfacealias') ?? '').replace(/^["']|["']$/g, '').toLowerCase();
    const nhFilter = (params.get('nexthop') ?? '').replace(/^["']|["']$/g, '');
    const metricFilter = params.has('routemetric') ? parseInt(params.get('routemetric')!, 10) : undefined;

    // Validate destination prefix format — must be CIDR notation (ip/prefix or ipv6/prefix)
    if (destFilter && !destFilter.match(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/) && !destFilter.match(/^[0-9a-f:]+\/\d+$/i)) {
      return `Get-NetRoute : Invalid DestinationPrefix: '${destFilter}'.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    }

    let routes = this.buildDefaultRoutes();
    if (destFilter) routes = routes.filter(r => r.dest === destFilter);
    if (ifFilter) routes = routes.filter(r => r.ifAlias.toLowerCase().includes(ifFilter));
    if (nhFilter) routes = routes.filter(r => r.nextHop === nhFilter);
    if (metricFilter !== undefined) routes = routes.filter(r => r.metric === metricFilter);

    if (routes.length === 0) return '';

    // Format as key-value blocks for pipeline compatibility (Select -ExpandProperty works on these)
    return routes.map((r, i) => [
      `DestinationPrefix : ${r.dest}`,
      `NextHop           : ${r.nextHop}`,
      `RouteMetric       : ${r.metric}`,
      `InterfaceAlias    : ${r.ifAlias}`,
      `InterfaceIndex    : ${i + 2}`,
      `AddressFamily     : IPv4`,
    ].join('\n')).join('\n\n');
  }

  private handleNewNetRoute(args: string[]): string {
    const params = this.parsePSArgs(args);
    const dest = (params.get('destinationprefix') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '');
    const ifAlias = (params.get('interfacealias') ?? '').replace(/^["']|["']$/g, '');
    const nextHop = (params.get('nexthop') ?? '').replace(/^["']|["']$/g, '');
    const metricStr = params.get('routemetric') ?? '0';
    const metric = parseInt(metricStr, 10);

    if (!dest) return `New-NetRoute : The -DestinationPrefix parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    if (!ifAlias) return `New-NetRoute : The -InterfaceAlias parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    if (!nextHop) return `New-NetRoute : The -NextHop parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;

    // Check for duplicates
    if (this.extraRoutes.has(dest)) {
      return `New-NetRoute : Route '${dest}' already exists.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    }

    this.extraRoutes.set(dest, { ifAlias, nextHop, metric });
    return [
      `DestinationPrefix : ${dest}`,
      `NextHop           : ${nextHop}`,
      `RouteMetric       : ${metric}`,
      `InterfaceAlias    : ${ifAlias}`,
      `InterfaceIndex    : 2`,
      `AddressFamily     : IPv4`,
    ].join('\n');
  }

  private handleRemoveNetRoute(args: string[]): string {
    const params = this.parsePSArgs(args);
    const dest = (params.get('destinationprefix') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '');
    const whatif = args.some(a => a.toLowerCase() === '-whatif');

    if (!dest) return `Remove-NetRoute : The -DestinationPrefix parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;

    const routes = this.buildDefaultRoutes();
    const found = routes.find(r => r.dest === dest);
    if (!found && !this.extraRoutes.has(dest)) {
      return `Remove-NetRoute : No MSFT_NetRoute objects found with property 'DestinationPrefix' equal to '${dest}'.`;
    }

    if (whatif) {
      return `What if: Performing the operation "Remove-NetRoute" on target "DestinationPrefix: ${dest}".`;
    }

    this.extraRoutes.delete(dest);
    return '';
  }

  private handleGetDnsClientServerAddress(args: string[]): string {
    const params = this.parsePSArgs(args);
    const ifFilter = (params.get('interfacealias') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '').toLowerCase();
    const afFilter = (params.get('addressfamily') ?? '').toLowerCase();

    const ports = this.device.getPortsMap();
    const lines: string[] = ['', 'InterfaceAlias               ServerAddresses', '--------------               ---------------'];
    let found = false;

    for (const [name] of ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      if (ifFilter && !displayName.toLowerCase().includes(ifFilter) && displayName.toLowerCase() !== ifFilter) continue;
      if (afFilter === 'ipv6') continue; // Only show IPv4 DNS in sim
      const servers = this.device.getDnsServers(name);
      lines.push(`${displayName.padEnd(29)}${servers.join(', ')}`);
      found = true;
    }

    if (!found && ifFilter) {
      return `Get-DnsClientServerAddress : Interface '${ifFilter}' not found. No MSFT_DnsClientServerAddress objects found matching the specified interface.`;
    }

    return lines.join('\n');
  }

  private handleSetDnsClientServerAddress(args: string[]): string {
    const params = this.parsePSArgs(args);
    const ifAlias = (params.get('interfacealias') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '');
    const serversRaw = (params.get('serveraddresses') ?? '').replace(/^["']|["']$/g, '');
    const reset = params.has('resetserveraddresses');

    if (!ifAlias) {
      return `Set-DnsClientServerAddress : The -InterfaceAlias parameter is mandatory.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    }

    // Find matching port name
    const ports = this.device.getPortsMap();
    let matchedName = '';
    for (const [name] of ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      const dn = displayName.toLowerCase();
      const af = ifAlias.toLowerCase();
      if (dn === af || name.toLowerCase() === af || dn.includes(af) || dn.startsWith(af)) {
        matchedName = name;
        break;
      }
    }

    if (!matchedName) {
      return `Set-DnsClientServerAddress : Interface '${ifAlias}' not found.`;
    }

    if (reset) {
      this.device.setDnsServers?.(matchedName, []);
      return '';
    }

    // Strip outer parens if present: ("8.8.8.8","1.1.1.1") → "8.8.8.8","1.1.1.1"
    const cleanRaw = serversRaw.replace(/^\(|\)$/g, '');
    const servers = cleanRaw.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    this.device.setDnsServers?.(matchedName, servers);
    return '';
  }

  private readonly DISKS = [
    { Number: 0, FriendlyName: 'Microsoft Virtual Disk', UniqueId: '{00000000-0000-0000-0000-000000000001}', SerialNumber: '', OperationalStatus: 'Online', TotalSize: '50 GB', PartitionStyle: 'MBR', IsBoot: true, IsSystem: true },
  ];

  private handleGetDisk(args: string[]): string {
    const params = this.parsePSArgs(args);
    const numberFilter = params.get('number');
    const friendlyName = (params.get('friendlyname') ?? '').replace(/^["']|["']$/g, '');
    const uniqueId = (params.get('uniqueid') ?? '').replace(/^["']|["']$/g, '');
    const serialNumber = (params.get('serialnumber') ?? '').replace(/^["']|["']$/g, '');

    let disks = [...this.DISKS];

    if (numberFilter !== undefined) {
      const num = parseInt(numberFilter, 10);
      disks = disks.filter(d => d.Number === num);
      if (disks.length === 0) return `Get-Disk : No MSFT_Disk objects found with Number = ${num}.\n    + CategoryInfo          : ObjectNotFound: (${num}:UInt32) [Get-Disk], CimException`;
    }
    if (friendlyName) {
      disks = disks.filter(d => d.FriendlyName.toLowerCase().includes(friendlyName.toLowerCase()));
      if (disks.length === 0) return `Get-Disk : No MSFT_Disk objects found with FriendlyName = '${friendlyName}'.`;
    }
    if (uniqueId) {
      disks = disks.filter(d => d.UniqueId === uniqueId);
      if (disks.length === 0) return `Get-Disk : No MSFT_Disk objects found with UniqueId = '${uniqueId}'.`;
    }
    if (serialNumber) {
      disks = disks.filter(d => d.SerialNumber === serialNumber);
      if (disks.length === 0) return `Get-Disk : No MSFT_Disk objects found with SerialNumber = '${serialNumber}'.`;
    }

    if (disks.length === 1) {
      const d = disks[0];
      return [
        '',
        'Number FriendlyName                      OperationalStatus TotalSize PartitionStyle IsBoot IsSystem UniqueId',
        '------ ------------                      ----------------- --------- -------------- ------ -------- --------',
        `${String(d.Number).padEnd(7)}${d.FriendlyName.padEnd(34)}${d.OperationalStatus.padEnd(18)}${d.TotalSize.padEnd(10)}${d.PartitionStyle.padEnd(15)}${String(d.IsBoot).padEnd(7)}${String(d.IsSystem).padEnd(9)}${d.UniqueId}`,
        '',
        `Number            : ${d.Number}`,
        `Friendly Name     : ${d.FriendlyName}`,
        `UniqueId          : ${d.UniqueId}`,
        `OperationalStatus : ${d.OperationalStatus}`,
        `PartitionStyle    : ${d.PartitionStyle}`,
        `TotalSize         : ${d.TotalSize}`,
        `IsBoot            : ${d.IsBoot}`,
        `IsSystem          : ${d.IsSystem}`,
      ].join('\n');
    }

    const lines: string[] = [
      '',
      'Number FriendlyName                      OperationalStatus TotalSize PartitionStyle IsBoot IsSystem UniqueId',
      '------ ------------                      ----------------- --------- -------------- ------ -------- --------',
    ];
    for (const d of disks) {
      lines.push(`${String(d.Number).padEnd(7)}${d.FriendlyName.padEnd(34)}${d.OperationalStatus.padEnd(18)}${d.TotalSize.padEnd(10)}${d.PartitionStyle.padEnd(15)}${String(d.IsBoot).padEnd(7)}${String(d.IsSystem).padEnd(9)}${d.UniqueId}`);
    }
    return lines.join('\n');
  }

  private handleGetVolume(args: string[]): string {
    const params = this.parsePSArgs(args);
    const driveLetter = (params.get('driveletter') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '').toUpperCase();

    const volumes = [
      { DriveLetter: 'C', FriendlyName: 'Windows', FileSystem: 'NTFS', DriveType: 'Fixed', HealthStatus: 'Healthy', OperationalStatus: 'OK', SizeRemaining: '15.2 GB', Size: '50.0 GB' },
      { DriveLetter: 'D', FriendlyName: 'Data',    FileSystem: 'NTFS', DriveType: 'Fixed', HealthStatus: 'Healthy', OperationalStatus: 'OK', SizeRemaining: '45.0 GB', Size: '50.0 GB' },
    ];

    let filtered = driveLetter ? volumes.filter(v => v.DriveLetter === driveLetter) : volumes;
    if (driveLetter && filtered.length === 0) return `Get-Volume : No MSFT_Volume objects found with DriveLetter = ${driveLetter}.`;

    if (filtered.length === 1) {
      const v = filtered[0];
      return [
        '',
        'DriveLetter FriendlyName FileSystem DriveType HealthStatus OperationalStatus SizeRemaining  Size',
        '----------- ------------ ---------- --------- ------------ ----------------- -------------  ----',
        `${v.DriveLetter.padEnd(12)}${v.FriendlyName.padEnd(13)}${v.FileSystem.padEnd(11)}${v.DriveType.padEnd(10)}${v.HealthStatus.padEnd(13)}${v.OperationalStatus.padEnd(18)}${v.SizeRemaining.padEnd(15)}${v.Size}`,
        '',
        `DriveLetter       : ${v.DriveLetter}`,
        `FriendlyName      : ${v.FriendlyName}`,
        `FileSystem        : ${v.FileSystem}`,
        `DriveType         : ${v.DriveType}`,
        `HealthStatus      : ${v.HealthStatus}`,
        `OperationalStatus : ${v.OperationalStatus}`,
        `SizeRemaining     : ${v.SizeRemaining}`,
        `Size              : ${v.Size}`,
      ].join('\n');
    }

    const lines: string[] = [
      '',
      'DriveLetter FriendlyName FileSystem DriveType HealthStatus OperationalStatus SizeRemaining  Size',
      '----------- ------------ ---------- --------- ------------ ----------------- -------------  ----',
    ];
    for (const v of filtered) {
      lines.push(`${v.DriveLetter.padEnd(12)}${v.FriendlyName.padEnd(13)}${v.FileSystem.padEnd(11)}${v.DriveType.padEnd(10)}${v.HealthStatus.padEnd(13)}${v.OperationalStatus.padEnd(18)}${v.SizeRemaining.padEnd(15)}${v.Size}`);
    }
    return lines.join('\n');
  }

  private handleGetNetAdapter(args: string[]): string {
    const params = this.parsePSArgs(args);
    const nameFilter = (params.get('name') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '').toLowerCase();
    const includeHidden = params.has('includehidden');
    const physical = params.has('physical');
    const cimSession = params.get('cimsession');

    if (cimSession) {
      return `Get-NetAdapter : Remote CIM sessions are not supported in this simulator.\n    + CategoryInfo          : NotImplemented: (:) [Get-NetAdapter], NotSupportedException`;
    }

    const ports = this.device.getPortsMap();
    const lines: string[] = ['Name                      InterfaceDescription                    ifIndex Status       MacAddress         LinkSpeed',
                              '----                      --------------------                    ------- ------       ----------         ---------'];
    let idx = 0;
    let found = false;
    for (const [name, port] of ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      if (nameFilter && !displayName.toLowerCase().includes(nameFilter) && displayName.toLowerCase() !== nameFilter) { idx++; continue; }
      const mac = port.getMAC()?.toString()?.replace(/:/g, '-').toUpperCase() ?? '00-00-00-00-00-00';
      const status = port.getIsUp() ? 'Up' : 'Disconnected';
      if (physical && !port.getIsUp() && !includeHidden) { idx++; continue; }
      const ifIndex = idx + 2;
      lines.push(`${displayName.padEnd(26)}${'Intel(R) Ethernet Connection'.padEnd(40)}${String(ifIndex).padStart(7)} ${status.padEnd(13)}${mac.padEnd(19)}1 Gbps`);
      found = true;
      idx++;
    }

    // -IncludeHidden shows hidden adapters (Loopback, virtual)
    if (includeHidden && (!nameFilter || 'loopback'.includes(nameFilter))) {
      lines.push(`${'Loopback Pseudo-Interface 1'.padEnd(26)}${'Software Loopback Interface 1'.padEnd(40)}${String(1).padStart(7)} ${'Up'.padEnd(13)}${'00-00-00-00-00-00'.padEnd(19)}10 Gbps`);
      found = true;
    }

    if (!found && nameFilter) {
      return `Get-NetAdapter : No MSFT_NetAdapter objects found with property 'Name' equal to '${nameFilter}'.`;
    }

    return lines.join('\n');
  }

  private formatGetNetIPAddress(): string {
    return this.handleGetNetIPAddress([]);
  }

  private formatGetNetTCPConnection(args: string[]): string {
    const ports = this.device.getPortsMap();
    // Simulate standard TCP connections for a Windows PC
    const lines: string[] = [
      '',
      'LocalAddress           LocalPort RemoteAddress          RemotePort State       AppliedSetting',
      '------------           --------- -------------          ---------- -----       --------------',
    ];

    // Listening ports based on running services
    const serviceMgr = this.device.getServiceManager();
    const runningServices = serviceMgr.getAllServices().filter(s => s.status === 'Running');
    const listeningPorts: Array<{ port: number; name: string }> = [
      { port: 135, name: 'RpcSs' },
      { port: 445, name: 'LanmanServer' },
      { port: 49152, name: 'Services' },
    ];
    for (const svc of runningServices) {
      if (svc.name === 'WinRM') listeningPorts.push({ port: 5985, name: 'WinRM' });
    }

    let localIp = '0.0.0.0';
    for (const port of ports.values()) {
      const ip = port.getIPAddress();
      if (ip) { localIp = ip; break; }
    }

    const params = this.parsePSArgs(args);
    const stateFilter = params.get('state')?.toLowerCase();

    for (const lp of listeningPorts) {
      if (!stateFilter || stateFilter === 'listen') {
        lines.push(`${('0.0.0.0').padEnd(23)}${String(lp.port).padEnd(10)}${'0.0.0.0'.padEnd(23)}${'0'.padEnd(11)}Listen`);
      }
    }

    // Simulate established connection to DNS server
    if (!stateFilter || stateFilter === 'established') {
      lines.push(`${localIp.padEnd(23)}${String(49153 + Math.floor(Math.random() * 100)).padEnd(10)}${'8.8.8.8'.padEnd(23)}${'53'.padEnd(11)}Established`);
    }

    if (lines.length <= 3) return '';
    return lines.join('\n');
  }

  private formatGetNetFirewallRule(args: string[]): string {
    const lines: string[] = [
      '',
      'Name                  DisplayName                  Enabled Action Direction',
      '----                  -----------                  ------- ------ ---------',
      'CoreNet-DHCP-In       DHCP (UDP-In)                True    Allow  Inbound',
      'CoreNet-DHCP-Out      DHCP (UDP-Out)               True    Allow  Outbound',
      'CoreNet-DNS-Out       DNS (UDP-Out)                True    Allow  Outbound',
      'FPS-ICMP4-ERQ-In      File and Printer Sharing...  True    Allow  Inbound',
      'RemoteDesktop-In-TCP  Remote Desktop - User Mode   False   Allow  Inbound',
      'WinRM-HTTP-In-TCP     Windows Remote Management    False   Allow  Inbound',
      'BlockTelemetry        Block Windows Telemetry      True    Block  Outbound',
    ];
    const params = this.parsePSArgs(args);
    const nameFilter = (params.get('name') || params.get('_positional') || '').toLowerCase();
    if (nameFilter) {
      return lines.filter((l, i) => i < 3 || l.toLowerCase().includes(nameFilter)).join('\n');
    }
    return lines.join('\n');
  }

  private maskToPrefixLength(mask: string): number {
    const parts = mask.split('.').map(Number);
    let bits = 0;
    for (const p of parts) {
      bits += (p >>> 0).toString(2).split('').filter(b => b === '1').length;
    }
    return bits;
  }

  private formatGetProcess(): string {
    const lines: string[] = [];
    lines.push('');
    lines.push('Handles  NPM(K)    PM(K)      WS(K)     CPU(s)     Id  SI ProcessName');
    lines.push('-------  ------    -----      -----     ------     --  -- -----------');

    const processes: Array<[string, number, number, number, number, number, number, number]> = [
      // [name, handles, npm, pm, ws, cpu, pid, si]
      ['cmd',              52,   5,   2036,    3556,   0.02,  5120, 1],
      ['conhost',         186,  12,   7032,   13568,   0.08,  5132, 1],
      ['csrss',           596,  18,   3256,    6144,   3.45,   472, 0],
      ['dwm',            1258,  35,  78320,   98816,  24.56,  1024, 1],
      ['explorer',       2456,  89, 112640,  165888,  45.23,  2848, 1],
      ['lsass',           856,  23,  12288,   15360,   1.23,   636, 0],
      ['services',        416,  14,   6144,    9216,   0.98,   620, 0],
      ['smss',             53,   3,    512,    1280,   0.05,   340, 0],
      ['svchost',         648,  22,  18432,   24576,   2.34,   784, 0],
      ['svchost',         423,  15,  10240,   14336,   1.56,   836, 0],
      ['System',          188,   0,    144,    1024,   0.00,     4, 0],
      ['wininit',         108,   5,   2560,    4608,   0.12,   548, 0],
    ];

    for (const [name, handles, npm, pm, ws, cpu, pid, si] of processes) {
      lines.push(
        `${String(handles).padStart(7)}  ${String(npm).padStart(6)}    ${String(pm).padStart(5)}      ${String(ws).padStart(5)}     ${cpu.toFixed(2).padStart(6)}  ${String(pid).padStart(4)}   ${si} ${name}`
      );
    }
    return lines.join('\n');
  }

  private formatGetService(): string {
    return [
      'Status   Name               DisplayName',
      '------   ----               -----------',
      'Running  Dhcp               DHCP Client',
      'Running  Dnscache           DNS Client',
      'Running  EventLog           Windows Event Log',
      'Running  LanmanServer       Server',
      'Running  LanmanWorkstation  Workstation',
      'Running  mpssvc             Windows Defender Firewall',
      'Running  RpcSs              Remote Procedure Call (RPC)',
      'Running  Spooler            Print Spooler',
      'Running  W32Time            Windows Time',
      'Running  WinRM              Windows Remote Management (WS-Manag...',
    ].join('\n');
  }

  private formatGetCimInstance(args: string[]): string {
    const className = args.find(a => !a.startsWith('-')) || '';
    if (className.toLowerCase() === 'win32_operatingsystem') {
      return `SystemDirectory : C:\\Windows\\system32\nOrganization    : \nBuildNumber     : 22631\nRegisteredUser  : User\nSerialNumber    : 00000-00000-00000-AA000\nVersion         : 10.0.22631`;
    }
    if (className.toLowerCase() === 'win32_computersystem') {
      return `Domain              : WORKGROUP\nManufacturer        : Microsoft Corporation\nModel               : Virtual Machine\nName                : ${this.device.getHostname()}\nPrimaryOwnerName    : User\nTotalPhysicalMemory : 8589934592`;
    }
    return `Get-CimInstance : Invalid class "${className}"`;
  }

  // ─── File management cmdlets ────────────────────────────────────

  private handleTestPath(args: string[]): string {
    const target = args.filter(a => !a.startsWith('-')).join(' ');
    if (!target) return 'False';
    if (isRegistryPath(target)) return this.registry.testPath(target) ? 'True' : 'False';
    const fs = this.device.getFileSystem();
    const absPath = fs.normalizePath(target, this.cwd);
    return fs.exists(absPath) ? 'True' : 'False';
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

  private handleResolvePath(args: string[]): string {
    const fs = this.device.getFileSystem();
    const target = args.filter(a => !a.startsWith('-')).join(' ');
    if (!target) return "Resolve-Path : Cannot bind argument to parameter 'Path' because it is an empty string.";
    const absPath = fs.normalizePath(target, this.cwd);
    if (!fs.exists(absPath)) return `Resolve-Path : Cannot find path '${target}' because it does not exist.`;
    return `\nPath\n----\n${absPath}\n`;
  }

  private handleSplitPath(args: string[]): string {
    let target = '';
    let leaf = false;
    let parent = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-Leaf') { leaf = true; continue; }
      if (args[i] === '-Parent') { parent = true; continue; }
      if (args[i] === '-Path' && args[i + 1]) { target = args[++i]; continue; }
      if (!args[i].startsWith('-') && !target) { target = args[i]; }
    }
    if (!target) return '';
    if (leaf) {
      const lastSep = target.lastIndexOf('\\');
      return lastSep >= 0 ? target.substring(lastSep + 1) : target;
    }
    // Default: parent
    const lastSep = target.lastIndexOf('\\');
    return lastSep >= 0 ? target.substring(0, lastSep) : '';
  }

  private handleJoinPath(args: string[]): string {
    let parentPath = '', childPath = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-Path' && args[i + 1]) { parentPath = args[++i]; continue; }
      if (args[i] === '-ChildPath' && args[i + 1]) { childPath = args[++i]; continue; }
      if (!args[i].startsWith('-')) {
        if (!parentPath) { parentPath = args[i]; }
        else if (!childPath) { childPath = args[i]; }
      }
    }
    if (!parentPath) return '';
    if (!childPath) return parentPath;
    const sep = parentPath.endsWith('\\') ? '' : '\\';
    return `${parentPath}${sep}${childPath}`;
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
    // First: reassemble quoted tokens
    const merged: string[] = [];
    let buf = '';
    let inQuote = false;
    for (const tok of args) {
      if (inQuote) {
        buf += ' ' + tok;
        if (tok.endsWith('"') || tok.endsWith("'")) {
          inQuote = false;
          merged.push(buf);
          buf = '';
        }
      } else if ((tok.startsWith('"') && !tok.endsWith('"')) || (tok.startsWith("'") && !tok.endsWith("'"))) {
        inQuote = true;
        buf = tok;
      } else {
        merged.push(tok);
      }
    }
    if (buf) merged.push(buf);

    const result = new Map<string, string>();
    const positional: string[] = [];
    for (let i = 0; i < merged.length; i++) {
      if (merged[i].startsWith('-') && i + 1 < merged.length && !merged[i + 1].startsWith('-')) {
        result.set(merged[i].substring(1).toLowerCase(), merged[i + 1].replace(/^["']|["']$/g, ''));
        i++;
      } else if (merged[i].startsWith('-')) {
        result.set(merged[i].substring(1).toLowerCase(), 'true');
      } else {
        positional.push(merged[i].replace(/^["']|["']$/g, ''));
      }
    }
    if (positional.length > 0) result.set('_positional', positional[0]);
    return result;
  }

  private handleGetLocalUser(args: string[]): string {
    const mgr = this.device.getUserManager();
    const params = this.parsePSArgs(args);
    const name = params.get('name') || params.get('_positional');

    if (name) {
      const user = mgr.getUser(name);
      if (!user) return `Get-LocalUser : User not found. '${name}' was not found.`;
      const lines: string[] = [''];
      lines.push('Name'.padEnd(24) + 'Enabled'.padEnd(10) + 'Description');
      lines.push('----'.padEnd(24) + '-------'.padEnd(10) + '-----------');
      lines.push(
        user.name.padEnd(24) +
        (user.enabled ? 'True' : 'False').padEnd(10) +
        user.description
      );
      if (user.fullName) lines.push(`\nFullName: ${user.fullName}`);
      return lines.join('\n');
    }

    const users = mgr.getAllUsers();
    const lines: string[] = [''];
    lines.push('Name'.padEnd(24) + 'Enabled'.padEnd(10) + 'Description');
    lines.push('----'.padEnd(24) + '-------'.padEnd(10) + '-----------');
    for (const u of users) {
      lines.push(
        u.name.padEnd(24) +
        (u.enabled ? 'True' : 'False').padEnd(10) +
        u.description
      );
    }
    return lines.join('\n');
  }

  private handleNewLocalUser(args: string[]): string {
    const mgr = this.device.getUserManager();
    if (!mgr.isCurrentUserAdmin()) return 'New-LocalUser : Access is denied.';
    const params = this.parsePSArgs(args);
    const name = params.get('name') || params.get('_positional') || '';
    const password = params.get('password') || '';
    const description = params.get('description') || '';
    const noPassword = params.has('nopassword');

    if (!name) return "New-LocalUser : Cannot bind argument to parameter 'Name' because it is an empty string.";

    const err = mgr.createUser(name, password, { description, noPassword });
    if (err) {
      if (err.includes('already exists')) return `New-LocalUser : User '${name}' already exists.`;
      return `New-LocalUser : ${err}`;
    }
    mgr.addGroupMember('Users', name);
    // Return user summary
    return this.handleGetLocalUser(['-Name', name]);
  }

  private handleSetLocalUser(args: string[]): string {
    const mgr = this.device.getUserManager();
    if (!mgr.isCurrentUserAdmin()) return 'Set-LocalUser : Access is denied.';
    // Re-merge args, accounting for AccountDisabled:$false (colon-style switch)
    const expanded: string[] = [];
    for (const a of args) {
      // -AccountDisabled:$false → treat as -AccountDisabled false
      if (/^-AccountDisabled:/i.test(a)) {
        const val = a.split(':')[1];
        expanded.push('-AccountDisabled', val);
      } else {
        expanded.push(a);
      }
    }
    const params = this.parsePSArgs(expanded);
    const name = params.get('name') || params.get('_positional') || '';
    if (!name) return "Set-LocalUser : Cannot bind argument to parameter 'Name' because it is an empty string.";

    const user = mgr.getUser(name);
    if (!user) return `Set-LocalUser : User not found. No user named '${name}' exists on this computer.`;

    if (params.has('description')) {
      const err = mgr.setUserProperty(name, 'description', params.get('description')!);
      if (err) return `Set-LocalUser : ${err}`;
    }
    if (params.has('password')) {
      const err = mgr.setUserProperty(name, 'password', params.get('password')!);
      if (err) return `Set-LocalUser : ${err}`;
    }
    if (params.has('fullname')) {
      const err = mgr.setUserProperty(name, 'fullname', params.get('fullname')!);
      if (err) return `Set-LocalUser : ${err}`;
    }
    if (params.has('accountdisabled')) {
      const val = params.get('accountdisabled');
      // "true" or flag-only → disable; "$false" / "false" → enable
      const disable = val !== '$false' && val !== 'false';
      const err = disable ? mgr.disableUser(name) : mgr.enableUser(name);
      if (err) return `Set-LocalUser : ${err}`;
    }
    return '';
  }

  private handleRemoveLocalUser(args: string[]): string {
    const mgr = this.device.getUserManager();
    if (!mgr.isCurrentUserAdmin()) return 'Remove-LocalUser : Access is denied.';
    const params = this.parsePSArgs(args);
    const name = params.get('name') || params.get('_positional') || '';
    if (!name) return "Remove-LocalUser : Cannot bind argument to parameter 'Name' because it is an empty string.";

    const err = mgr.deleteUser(name);
    if (err) {
      if (err.includes('could not be found')) return `Remove-LocalUser : User '${name}' was not found.`;
      if (err.includes('Cannot delete')) return `Remove-LocalUser : ${err}`;
      return `Remove-LocalUser : ${err}`;
    }
    return '';
  }

  private handleEnableLocalUser(args: string[]): string {
    const mgr = this.device.getUserManager();
    if (!mgr.isCurrentUserAdmin()) return 'Enable-LocalUser : Access is denied.';
    const params = this.parsePSArgs(args);
    const name = params.get('name') || params.get('_positional') || '';
    if (!name) return "Enable-LocalUser : Cannot bind argument to parameter 'Name' because it is an empty string.";
    const err = mgr.enableUser(name);
    if (err) return `Enable-LocalUser : ${err}`;
    return '';
  }

  private handleDisableLocalUser(args: string[]): string {
    const mgr = this.device.getUserManager();
    if (!mgr.isCurrentUserAdmin()) return 'Disable-LocalUser : Access is denied.';
    const params = this.parsePSArgs(args);
    const name = params.get('name') || params.get('_positional') || '';
    if (!name) return "Disable-LocalUser : Cannot bind argument to parameter 'Name' because it is an empty string.";
    const err = mgr.disableUser(name);
    if (err) return `Disable-LocalUser : ${err}`;
    return '';
  }

  private handleGetLocalGroup(args: string[]): string {
    const mgr = this.device.getUserManager();
    const params = this.parsePSArgs(args);
    const name = params.get('name') || params.get('_positional');

    if (name) {
      const group = mgr.getGroup(name);
      if (!group) return `Get-LocalGroup : Group not found. '${name}' was not found.`;
      const lines: string[] = [''];
      lines.push('Name'.padEnd(36) + 'Description');
      lines.push('----'.padEnd(36) + '-----------');
      lines.push(group.name.padEnd(36) + group.description);
      return lines.join('\n');
    }

    const groups = mgr.getAllGroups();
    const lines: string[] = [''];
    lines.push('Name'.padEnd(36) + 'Description');
    lines.push('----'.padEnd(36) + '-----------');
    for (const g of groups) {
      lines.push(g.name.padEnd(36) + g.description);
    }
    return lines.join('\n');
  }

  private handleNewLocalGroup(args: string[]): string {
    const mgr = this.device.getUserManager();
    if (!mgr.isCurrentUserAdmin()) return 'New-LocalGroup : Access is denied.';
    const params = this.parsePSArgs(args);
    const name = params.get('name') || params.get('_positional') || '';
    const description = params.get('description') || '';
    if (!name) return "New-LocalGroup : Cannot bind argument to parameter 'Name' because it is an empty string.";

    const err = mgr.createGroup(name, description);
    if (err) return `New-LocalGroup : ${err}`;
    return this.handleGetLocalGroup(['-Name', name]);
  }

  private handleRemoveLocalGroup(args: string[]): string {
    const mgr = this.device.getUserManager();
    if (!mgr.isCurrentUserAdmin()) return 'Remove-LocalGroup : Access is denied.';
    const params = this.parsePSArgs(args);
    const name = params.get('name') || params.get('_positional') || '';
    if (!name) return "Remove-LocalGroup : Cannot bind argument to parameter 'Name' because it is an empty string.";

    const err = mgr.deleteGroup(name);
    if (err) {
      if (err.includes('Cannot delete')) return `Remove-LocalGroup : ${err}`;
      return `Remove-LocalGroup : ${err}`;
    }
    return '';
  }

  private handleAddLocalGroupMember(args: string[]): string {
    const mgr = this.device.getUserManager();
    if (!mgr.isCurrentUserAdmin()) return 'Add-LocalGroupMember : Access is denied.';

    // Collect group name and ALL tokens after -Member (PS array syntax: "UserA, UserB" or "UserA","UserB")
    let group = '';
    const memberTokens: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const lower = args[i].toLowerCase();
      if (lower === '-group' && args[i + 1]) { group = args[++i].replace(/^["']|["']$/g, ''); }
      else if (lower === '-member') {
        i++;
        while (i < args.length && !args[i].startsWith('-')) {
          memberTokens.push(args[i]);
          i++;
        }
        i--;
      } else if (!args[i].startsWith('-') && !group) {
        group = args[i].replace(/^["']|["']$/g, '');
      }
    }
    const memberRaw = memberTokens.join(' ');
    if (!group || !memberRaw) return "Add-LocalGroupMember : Cannot bind required parameter.";

    // Support comma-separated member list: "UserA, UserB"
    const members = memberRaw.split(',').map(m => m.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    const errors: string[] = [];
    for (const member of members) {
      const err = mgr.addGroupMember(group, member);
      if (err) {
        if (err.includes('was not found') || err.includes('could not be found')) {
          errors.push(`Add-LocalGroupMember : Cannot find user '${member}'. The specified user was not found.`);
        } else if (err.includes('already a member')) {
          errors.push(`Add-LocalGroupMember : The specified account '${member}' is already a member of the group.`);
        } else {
          errors.push(`Add-LocalGroupMember : ${err}`);
        }
      }
    }
    return errors.join('\n');

  }

  private handleRemoveLocalGroupMember(args: string[]): string {
    const mgr = this.device.getUserManager();
    if (!mgr.isCurrentUserAdmin()) return 'Remove-LocalGroupMember : Access is denied.';
    const params = this.parsePSArgs(args);
    const group = params.get('group') || '';
    const member = params.get('member') || '';
    if (!group || !member) return "Remove-LocalGroupMember : Cannot bind required parameter.";

    const err = mgr.removeGroupMember(group, member);
    if (err) return `Remove-LocalGroupMember : ${err}`;
    return '';
  }

  private handleGetLocalGroupMember(args: string[]): string {
    const mgr = this.device.getUserManager();
    const params = this.parsePSArgs(args);
    const groupName = params.get('group') || '';
    if (!groupName) return "Get-LocalGroupMember : Cannot bind required parameter 'Group'.";

    const { members, error } = mgr.getGroupMembers(groupName);
    if (error) return `Get-LocalGroupMember : ${error}`;

    const lines: string[] = [''];
    lines.push('ObjectClass'.padEnd(16) + 'Name'.padEnd(30) + 'PrincipalSource');
    lines.push('-----------'.padEnd(16) + '----'.padEnd(30) + '---------------');
    for (const m of members) {
      lines.push('User'.padEnd(16) + m.padEnd(30) + 'Local');
    }
    return lines.join('\n');
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
    return '';
  }

  private handleRenameLocalUser(args: string[]): string {
    const params = this.parsePSArgs(args);
    const name = params.get('name') || params.get('_positional') || '';
    const newName = params.get('newname') || '';
    if (!name) return "Rename-LocalUser : The -Name parameter is required.";
    if (!newName) return "Rename-LocalUser : The -NewName parameter is required.";
    const error = this.device.getUserManager().renameUser(name, newName);
    return error || '';
  }

  private handleRenameLocalGroup(args: string[]): string {
    const params = this.parsePSArgs(args);
    const name = params.get('name') || params.get('_positional') || '';
    const newName = params.get('newname') || '';
    if (!name) return "Rename-LocalGroup : The -Name parameter is required.";
    if (!newName) return "Rename-LocalGroup : The -NewName parameter is required.";
    const error = this.device.getUserManager().renameGroup(name, newName);
    return error || '';
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
