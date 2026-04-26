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
    const funcDefMatch = trimmed.match(/^function\s+(\w+)\s*\{([\s\S]*)\}$/i);
    if (funcDefMatch) {
      const funcName = funcDefMatch[1].toLowerCase();
      const body = funcDefMatch[2].trim();
      const paramMatch = body.match(/^param\s*\(([^)]*)\)([\s\S]*)$/i);
      let params: string[] = [];
      let funcBody = body;
      if (paramMatch) {
        params = paramMatch[1].split(',').map(p => p.trim().replace(/^\$/, '').toLowerCase()).filter(Boolean);
        funcBody = paramMatch[2].trim();
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
      let value: string;
      if ((expr.startsWith('"') && expr.endsWith('"')) ||
          (expr.startsWith("'") && expr.endsWith("'"))) {
        value = expr.slice(1, -1);
      } else {
        const result = await this.executeSingle(this.substituteVars(expr));
        value = result?.trim() ?? '';
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

    // Parse named args: -ParamName value
    const localVars = new Map<string, string>(this.sessionVars);
    const savedVars = new Map<string, string>(this.sessionVars);
    const parsed = new Map<string, string>();
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-') && i + 1 < args.length) {
        const pname = args[i].slice(1).toLowerCase();
        parsed.set(pname, args[i + 1].replace(/^["']|["']$/g, ''));
        i++;
      }
    }
    // Bind params
    for (const param of fn.params) {
      if (parsed.has(param)) this.sessionVars.set(param, parsed.get(param)!);
    }

    // Execute body as a multi-statement script
    const result = await this.execute(fn.body);

    // Restore variables (simple scope)
    this.sessionVars = savedVars;

    return result;
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

      // Set-Content as pipeline sink — terminates the pipeline
      if (filterCmdLower === 'set-content') {
        const sinkArgs = this.tokenize(filter).slice(1);
        const content = this.pipelineToContent(currentOutput);
        return this.handleSetContentWithPiped(sinkArgs, content);
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

    for (const ch of cmdline) {
      if (inQuote) {
        current += ch;
        if (ch === inQuote) inQuote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inQuote = ch; current += ch; continue; }
      if (ch === '{') { braceDepth++; current += ch; continue; }
      if (ch === '}') { braceDepth--; current += ch; continue; }
      if (ch === '|' && braceDepth === 0) {
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
      case 'gps':
        return buildDynamicProcessObjects(this.buildPSProcessCtx()) as PSObject[];
      case 'get-service':
      case 'gsv':
        return buildDynamicServiceObjects(this.buildPSServiceCtx()) as PSObject[];
      case 'get-command':
      case 'gcm':
        return buildCommandObjects();
      default: {
        // Fall back to string output
        const result = await this.executeSingle(cmd);
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
    if ((trimmedLine.startsWith('"') && trimmedLine.endsWith('"') && trimmedLine.length > 1) ||
        (trimmedLine.startsWith("'") && trimmedLine.endsWith("'") && trimmedLine.length > 1)) {
      return trimmedLine.slice(1, -1);
    }

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

    // Property accessor: (command).PropertyName
    const propAccessMatch = trimmedLine.match(/^\((.+)\)\.(\w+)$/);
    if (propAccessMatch) {
      const innerCmd = propAccessMatch[1];
      const propName = propAccessMatch[2];
      const result = await this.executeSingle(innerCmd);
      if (!result) return '';
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
    const args = parts.slice(1);

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
      const target = args.join(' ') || 'C:\\Users\\User';
      const result = await this.device.executeCmdCommand('cd ' + target);
      await this.refreshCwd();
      return result || '';
    }

    // Get-Location / pwd / gl
    if (cmdLower === 'get-location' || cmdLower === 'gl' || cmdLower === 'pwd') {
      return `\nPath\n----\n${this.cwd}\n`;
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
      const nonFlags = args.filter(a => !a.startsWith('-'));
      return await this.device.executeCmdCommand('ren ' + nonFlags.join(' '));
    }

    // Write-Host / Write-Output / echo
    if (cmdLower === 'write-host' || cmdLower === 'write-output' || cmdLower === 'echo') {
      return args.join(' ').replace(/^["']|["']$/g, '');
    }

    // Clear-Host / cls / clear
    if (cmdLower === 'clear-host' || cmdLower === 'cls' || cmdLower === 'clear') {
      return null; // Caller handles screen clear
    }

    // Get-Process / gps / ps
    if (cmdLower === 'get-process' || cmdLower === 'gps') {
      return psGetProcess(this.buildPSProcessCtx(), args);
    }

    // Stop-Process / spps / kill
    if (cmdLower === 'stop-process' || cmdLower === 'spps' || cmdLower === 'kill') {
      return psStopProcess(this.buildPSProcessCtx(), args);
    }

    // Get-Help
    if (cmdLower === 'get-help') {
      return this.formatGetHelp(args[0]);
    }

    // Get-Command / gcm
    if (cmdLower === 'get-command' || cmdLower === 'gcm') {
      return this.formatGetCommand();
    }

    // Get-NetIPConfiguration
    if (cmdLower === 'get-netipconfiguration') {
      return this.formatGetNetIPConfiguration();
    }

    // Get-NetIPAddress
    if (cmdLower === 'get-netipaddress') {
      return this.formatGetNetIPAddress();
    }

    // Get-NetAdapter
    if (cmdLower === 'get-netadapter') {
      return this.formatGetNetAdapter();
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
      return [
        '',
        'Number Friendly Name                    OperationalStatus TotalSize PartitionStyle',
        '------ -------------                    ----------------- --------- --------------',
        '0      Microsoft Virtual Disk           Online                50 GB MBR',
      ].join('\n');
    }

    // Get-Volume
    if (cmdLower === 'get-volume') {
      return [
        '',
        'DriveLetter FriendlyName   FileSystemType DriveType HealthStatus OperationalStatus SizeRemaining      Size',
        '----------- ------------   -------------- --------- ------------ ----------------- -------------      ----',
        'C           Windows        NTFS           Fixed     Healthy      OK                     15.2 GB   50.0 GB',
        'D           Data           NTFS           Fixed     Healthy      OK                     45.0 GB   50.0 GB',
      ].join('\n');
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
    let tail: number | undefined, totalCount: number | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if ((a === '-path' || a === '-literalpath') && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-tail' && args[i + 1]) { tail = parseInt(args[++i], 10); }
      else if ((a === '-totalcount' || a === '-head' || a === '-first') && args[i + 1]) { totalCount = parseInt(args[++i], 10); }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
    }
    if (!path) return '';
    const absPath = fs.normalizePath(path, this.cwd);

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
    if (!content) return '';
    const lines = content.split(/\r?\n/);
    if (tail !== undefined) return lines.slice(-tail).join('\n');
    if (totalCount !== undefined) return lines.slice(0, totalCount).join('\n');
    return content;
  }

  private handleSetContent(args: string[]): string {
    const fs = this.device.getFileSystem();
    let path = '', value = '';
    const positionals: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-value' && args[i + 1]) {
        const raw = args[++i];
        const stripped = raw.replace(/^["']|["']$/g, '');
        const items = this.tryParseArrayLiteral(stripped);
        value = items ? items.join('\n') : stripped;
      }
      else if (!args[i].startsWith('-')) {
        const raw = args[i];
        // Try array parse BEFORE stripping quotes (to handle "a","b" correctly)
        const items = this.tryParseArrayLiteral(raw);
        if (items) { positionals.push(...items); }
        else { positionals.push(raw.replace(/^["']|["']$/g, '')); }
      }
    }
    // Positional: first is path, rest are values joined by newlines
    if (!path && positionals.length > 0) path = positionals[0];
    if (!value && positionals.length > 1) value = positionals.slice(1).join('\n');
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

  private handleGetChildItem(args: string[]): string {
    let path = '', filter = '', recurse = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-filter' && args[i + 1]) { filter = args[++i].replace(/^["']|["']$/g, ''); }
      else if (a === '-recurse') { recurse = true; }
      else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
    }

    // Env: drive
    if (path.toLowerCase() === 'env:' || path.toLowerCase() === 'env:\\') {
      return this.formatGetChildItemEnv();
    }

    // Registry path
    if (path && isRegistryPath(path)) return this.registry.getChildItem(path);

    const fs = this.device.getFileSystem();
    const absPath = fs.normalizePath(path || '.', this.cwd);

    if (recurse) {
      const allDirs = fs.listDirectoryRecursive(absPath);
      const lines: string[] = [];
      for (const { path: dirPath, entries } of allDirs) {
        let filtered = entries;
        if (filter) {
          const rx = new RegExp('^' + filter.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
          filtered = entries.filter(e => rx.test(e.entry.name));
        }
        if (filtered.length === 0) continue;
        lines.push('', `    Directory: ${dirPath}`, '', 'Mode                 LastWriteTime         Length Name', '----                 -------------         ------ ----');
        for (const { entry } of filtered) {
          const mode = this.formatPSMode(entry);
          const mtime = this.formatPSDate(entry.mtime);
          const length = entry.type === 'file' ? String(entry.size) : '';
          lines.push(`${mode.padEnd(20)} ${mtime} ${length.padStart(14)} ${entry.name}`);
        }
      }
      return lines.join('\n');
    }

    const entries = fs.listDirectory(absPath);
    let filtered = entries;
    if (filter) {
      const rx = new RegExp('^' + filter.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      filtered = entries.filter(e => rx.test(e.entry.name));
    }
    if (filtered.length === 0) return '';

    const lines: string[] = ['', `    Directory: ${absPath}`, '', 'Mode                 LastWriteTime         Length Name', '----                 -------------         ------ ----'];
    for (const { entry } of filtered) {
      const mode = this.formatPSMode(entry);
      const mtime = this.formatPSDate(entry.mtime);
      const length = entry.type === 'file' ? String(entry.size) : '';
      lines.push(`${mode.padEnd(20)} ${mtime} ${length.padStart(14)} ${entry.name}`);
    }
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
      const r = fs.deleteDirectory(absPath);
      return r.ok ? '' : `Remove-Item : ${r.error}`;
    }
    const r = fs.deleteFile(absPath);
    return r.ok ? '' : `Remove-Item : ${r.error}`;
  }

  private handleCopyItem(args: string[]): string {
    const fs = this.device.getFileSystem();
    let src = '', dest = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-path' && args[i + 1]) { src = args[++i].replace(/^["']|["']$/g, ''); }
      else if ((a === '-destination' || a === '-dest') && args[i + 1]) { dest = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && !src) { src = args[i].replace(/^["']|["']$/g, ''); }
      else if (!args[i].startsWith('-') && src && !dest) { dest = args[i].replace(/^["']|["']$/g, ''); }
    }
    if (!src || !dest) return 'Copy-Item : Source and Destination are required.';
    const absSrc = fs.normalizePath(src, this.cwd);
    const absDest = fs.normalizePath(dest, this.cwd);
    // Ensure dest drive root exists
    const destDrive = absDest.substring(0, 2).toUpperCase();
    if (!fs.resolve(destDrive + '\\')) fs.mkdirp(destDrive + '\\');
    const r = fs.copyFile(absSrc, absDest);
    return r.ok ? '' : `Copy-Item : ${r.error}`;
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

    if (replyLines.length === 0 && timeoutLines.length > 0) {
      return `Test-Connection : Testing connection to computer '${target}' failed: host unreachable.`;
    }

    lines.push('Source           Destination       IPV4Address      Bytes    Time(ms)');
    lines.push('------           -----------       -----------      -----    --------');

    for (const line of replyLines) {
      const ipMatch = line.match(/Reply from ([\d.]+)/);
      const timeMatch = line.match(/time[=<](\d+)/);
      const bytesMatch = line.match(/bytes=(\d+)/);
      const ip = ipMatch ? ipMatch[1] : target;
      const time = timeMatch ? timeMatch[1] : '0';
      const bytes = bytesMatch ? bytesMatch[1] : '32';
      lines.push(
        `${source.padEnd(17)}${target.padEnd(18)}${ip.padEnd(17)}${bytes.padEnd(9)}${time}`
      );
    }

    return lines.join('\n');
  }

  private formatGetHelp(topic?: string): string {
    return `TOPIC\n    Windows PowerShell Help System\n\nSHORT DESCRIPTION\n    Displays help about Windows PowerShell cmdlets and concepts.\n\nLONG DESCRIPTION\n    Windows PowerShell Help describes cmdlets, functions, scripts, and modules.\n\n    To get help for a cmdlet, type: Get-Help <cmdlet-name>\n\n${topic ? `Get-Help ${topic}: No help found for topic "${topic}".` : ''}`;
  }

  private formatGetCommand(): string {
    return [
      'CommandType     Name                                               Version    Source',
      '-----------     ----                                               -------    ------',
      'Cmdlet          Clear-Host                                         3.1.0.0    Microsoft.PowerShell.Core',
      'Cmdlet          Copy-Item                                          3.1.0.0    Microsoft.PowerShell.Management',
      'Cmdlet          Get-ChildItem                                      3.1.0.0    Microsoft.PowerShell.Management',
      'Cmdlet          Get-Command                                        3.0.0.0    Microsoft.PowerShell.Core',
      'Cmdlet          Get-Content                                        3.1.0.0    Microsoft.PowerShell.Management',
      'Cmdlet          Get-Help                                           3.0.0.0    Microsoft.PowerShell.Core',
      'Cmdlet          Get-Location                                       3.1.0.0    Microsoft.PowerShell.Management',
      'Cmdlet          Get-NetAdapter                                     2.0.0.0    NetAdapter',
      'Cmdlet          Get-NetIPAddress                                   1.0.0.0    NetTCPIP',
      'Cmdlet          Get-NetIPConfiguration                             1.0.0.0    NetTCPIP',
      'Cmdlet          Get-Process                                        3.1.0.0    Microsoft.PowerShell.Management',
      'Cmdlet          Move-Item                                          3.1.0.0    Microsoft.PowerShell.Management',
      'Cmdlet          New-Item                                           3.1.0.0    Microsoft.PowerShell.Management',
      'Cmdlet          Remove-Item                                        3.1.0.0    Microsoft.PowerShell.Management',
      'Cmdlet          Rename-Item                                        3.1.0.0    Microsoft.PowerShell.Management',
      'Cmdlet          Set-Content                                        3.1.0.0    Microsoft.PowerShell.Management',
      'Cmdlet          Set-Location                                       3.1.0.0    Microsoft.PowerShell.Management',
      'Cmdlet          Test-Connection                                    3.1.0.0    Microsoft.PowerShell.Management',
      'Cmdlet          Write-Host                                         3.1.0.0    Microsoft.PowerShell.Utility',
      'Cmdlet          Write-Output                                       3.1.0.0    Microsoft.PowerShell.Utility',
    ].join('\n');
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

  private formatGetNetIPConfiguration(): string {
    const ports = this.device.getPortsMap();
    const lines: string[] = [];
    let idx = 0;
    for (const [name, port] of ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      const ip = port.getIPAddress()?.toString() ?? '';
      const mask = port.getSubnetMask()?.toString() ?? '';
      const gw = this.device.getDefaultGateway() ?? '';
      const dns = this.device.getDnsServers(name);

      if (idx > 0) lines.push('');
      lines.push(`InterfaceAlias       : ${displayName}`);
      lines.push(`InterfaceIndex       : ${idx + 1}`);
      lines.push(`IPv4Address          : ${ip || 'Not configured'}`);
      if (mask) lines.push(`IPv4SubnetMask       : ${mask}`);
      lines.push(`IPv4DefaultGateway   : ${gw}`);
      lines.push(`DNSServer            : ${dns.length > 0 ? dns.join(', ') : ''}`);
      idx++;
    }
    return lines.join('\n');
  }

  private formatGetNetIPAddress(): string {
    const ports = this.device.getPortsMap();
    const lines: string[] = [];
    let idx = 0;
    for (const [name, port] of ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      const ip = port.getIPAddress()?.toString() ?? '';
      const mask = port.getSubnetMask()?.toString() ?? '';
      // Calculate prefix length from mask
      const prefixLength = mask ? this.maskToPrefixLength(mask) : 0;

      if (idx > 0) lines.push('');
      lines.push(`IPAddress         : ${ip || 'Not configured'}`);
      lines.push(`InterfaceIndex    : ${idx + 1}`);
      lines.push(`InterfaceAlias    : ${displayName}`);
      lines.push(`AddressFamily     : IPv4`);
      lines.push(`Type              : Unicast`);
      lines.push(`PrefixLength      : ${prefixLength}`);
      lines.push(`PrefixOrigin      : ${this.device.isDHCPConfigured(name) ? 'Dhcp' : 'Manual'}`);
      lines.push(`SuffixOrigin      : ${this.device.isDHCPConfigured(name) ? 'Dhcp' : 'Manual'}`);
      lines.push(`AddressState      : ${ip ? 'Preferred' : 'Invalid'}`);
      idx++;
    }
    // Add loopback
    if (lines.length > 0) lines.push('');
    lines.push('IPAddress         : 127.0.0.1');
    lines.push('InterfaceIndex    : 1');
    lines.push('InterfaceAlias    : Loopback Pseudo-Interface 1');
    lines.push('AddressFamily     : IPv4');
    lines.push('Type              : Unicast');
    lines.push('PrefixLength      : 8');
    lines.push('PrefixOrigin      : WellKnown');
    lines.push('SuffixOrigin      : WellKnown');
    lines.push('AddressState      : Preferred');
    return lines.join('\n');
  }

  private formatGetNetAdapter(): string {
    const ports = this.device.getPortsMap();
    const lines: string[] = [];
    lines.push('Name                      InterfaceDescription                    ifIndex Status       MacAddress         LinkSpeed');
    lines.push('----                      --------------------                    ------- ------       ----------         ---------');
    let idx = 0;
    for (const [name, port] of ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      const mac = port.getMAC()?.toString()?.replace(/:/g, '-').toUpperCase() ?? '00-00-00-00-00-00';
      const status = port.getIsUp() ? 'Up' : 'Disconnected';
      const ifIndex = idx + 2;
      lines.push(
        `${displayName.padEnd(26)}${('Intel(R) Ethernet Connection').padEnd(40)}${String(ifIndex).padStart(7)} ${status.padEnd(13)}${mac.padEnd(19)}1 Gbps`
      );
      idx++;
    }
    return lines.join('\n');
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

    const mode = this.formatPSMode(entry);
    const mtime = this.formatPSDate(entry.mtime);
    const length = entry.type === 'file' ? String(entry.size) : '';
    const lines: string[] = [];
    lines.push('');
    lines.push(`    Directory: ${absPath.substring(0, absPath.lastIndexOf('\\')) || absPath}`);
    lines.push('');
    lines.push('Mode                 LastWriteTime         Length Name');
    lines.push('----                 -------------         ------ ----');
    lines.push(`${mode.padEnd(20)} ${mtime} ${length.padStart(14)} ${entry.name}`);
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
