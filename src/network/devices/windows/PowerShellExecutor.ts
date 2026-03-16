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
import {
  runPipeline, formatDefault, formatTable,
  buildProcessObjects, buildServiceObjects, buildCommandObjects,
  type PSObject, type PipelineInput,
} from './PSPipeline';

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
  // Aliases
  'ls', 'dir', 'cd', 'pwd', 'cat', 'type', 'echo', 'cls', 'clear',
  'cp', 'mv', 'rm', 'del', 'ren', 'mkdir', 'rmdir',
  'ipconfig', 'ping', 'netsh', 'tracert', 'arp', 'route',
  'hostname', 'systeminfo', 'ver', 'exit', 'cmd',
];

// ─── Interface for device abstraction ─────────────────────────────

export interface PSDeviceContext {
  /** Execute a CMD-level command on the device */
  executeCommand(cmd: string): Promise<string>;
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
}

// ─── PowerShell Executor ──────────────────────────────────────────

export class PowerShellExecutor {
  private cwd: string;
  private device: PSDeviceContext;
  private commandHistory: string[];

  constructor(device: PSDeviceContext, initialCwd = 'C:\\Users\\User') {
    this.cwd = initialCwd;
    this.device = device;
    this.commandHistory = [];
  }

  getCwd(): string { return this.cwd; }
  setCwd(cwd: string): void { this.cwd = cwd; }

  getPrompt(): string { return `PS ${this.cwd}> `; }

  setHistory(history: string[]): void { this.commandHistory = history; }
  getHistory(): string[] { return this.commandHistory; }

  /**
   * Execute a PowerShell command line.
   * Returns null for clear-screen commands (caller should handle).
   */
  async execute(cmdline: string): Promise<string | null> {
    const trimmed = cmdline.trim();
    if (!trimmed) return '';

    // Handle pipeline
    if (trimmed.includes('|') && !trimmed.match(/[>]/)) {
      return this.executePipeline(trimmed);
    }

    return this.executeSingle(trimmed);
  }

  // ─── Pipeline handling ──────────────────────────────────────────

  private async executePipeline(cmdline: string): Promise<string | null> {
    const parts = this.splitPipeline(cmdline);
    if (parts.length < 2) return this.executeSingle(cmdline);

    // Execute first command — try to get structured output
    const firstOutput = await this.executeForPipeline(parts[0]);
    const filters = parts.slice(1);

    return runPipeline(firstOutput, filters);
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
  private async executeForPipeline(cmd: string): Promise<PipelineInput> {
    const cmdLower = cmd.trim().split(/\s+/)[0].toLowerCase();

    // Return structured data for known cmdlets
    switch (cmdLower) {
      case 'get-process':
      case 'gps':
        return buildProcessObjects();
      case 'get-service':
      case 'gsv':
        return buildServiceObjects();
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

  private async executeSingle(cmdline: string): Promise<string | null> {
    const parts = cmdline.split(/\s+/);
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
      return this.resolveEnvVar(cmd.slice(5));
    }

    if (cmdLower === '$true') return 'True';
    if (cmdLower === '$false') return 'False';
    if (cmdLower === '$null') return '';
    if (cmdLower === '$pid') return String(Math.floor(Math.random() * 10000 + 1000));

    // ─── Cmdlets mapped to device commands ────────────────────────

    // Get-ChildItem / ls / dir / gci
    if (cmdLower === 'get-childitem' || cmdLower === 'gci' || cmdLower === 'ls' || cmdLower === 'dir') {
      return this.formatGetChildItem(args.join(' '));
    }

    // Set-Location / cd / sl / chdir
    if (cmdLower === 'set-location' || cmdLower === 'sl' || cmdLower === 'cd' || cmdLower === 'chdir') {
      const target = args.join(' ') || 'C:\\Users\\User';
      const result = await this.device.executeCommand('cd ' + target);
      await this.refreshCwd();
      return result || '';
    }

    // Get-Location / pwd / gl
    if (cmdLower === 'get-location' || cmdLower === 'gl' || cmdLower === 'pwd') {
      return `\nPath\n----\n${this.cwd}\n`;
    }

    // Get-Content / cat / type / gc
    if (cmdLower === 'get-content' || cmdLower === 'gc' || cmdLower === 'cat' || cmdLower === 'type') {
      return await this.device.executeCommand('type ' + args.join(' '));
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
      const target = args.filter(a => !a.startsWith('-')).join(' ');
      return await this.device.executeCommand('del ' + target);
    }

    // Copy-Item / cpi / copy / cp
    if (cmdLower === 'copy-item' || cmdLower === 'cpi' || cmdLower === 'copy' || cmdLower === 'cp') {
      const nonFlags = args.filter(a => !a.startsWith('-'));
      return await this.device.executeCommand('copy ' + nonFlags.join(' '));
    }

    // Move-Item / mi / move / mv
    if (cmdLower === 'move-item' || cmdLower === 'mi' || cmdLower === 'move' || cmdLower === 'mv') {
      const nonFlags = args.filter(a => !a.startsWith('-'));
      return await this.device.executeCommand('move ' + nonFlags.join(' '));
    }

    // Rename-Item / rni / ren
    if (cmdLower === 'rename-item' || cmdLower === 'rni' || cmdLower === 'ren') {
      const nonFlags = args.filter(a => !a.startsWith('-'));
      return await this.device.executeCommand('ren ' + nonFlags.join(' '));
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
      return this.formatGetProcess();
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

    // Resolve-DnsName
    if (cmdLower === 'resolve-dnsname') {
      return 'Resolve-DnsName: DNS resolution is not available in this simulation.';
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
    if (['ipconfig', 'ping', 'netsh', 'tracert', 'route', 'arp', 'systeminfo', 'ver'].includes(cmdLower)) {
      return await this.device.executeCommand(cmdLower + ' ' + args.join(' '));
    }

    // Get-ExecutionPolicy / Set-ExecutionPolicy
    if (cmdLower === 'get-executionpolicy') return 'RemoteSigned';
    if (cmdLower === 'set-executionpolicy') return '';

    // Get-Service / gsv
    if (cmdLower === 'get-service' || cmdLower === 'gsv') {
      return this.formatGetService();
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

    // Fallback: try device command
    return this.executeFallback(cmdline);
  }

  // ─── Helper methods ─────────────────────────────────────────────

  async refreshCwd(): Promise<void> {
    const cdResult = await this.device.executeCommand('cd');
    if (cdResult && !cdResult.includes('not recognized')) {
      this.cwd = cdResult.trim();
    }
  }

  private resolveEnvVar(varName: string): string {
    const envMap: Record<string, string> = {
      'USERNAME': 'User', 'COMPUTERNAME': this.device.getHostname(),
      'USERPROFILE': 'C:\\Users\\User', 'SYSTEMROOT': 'C:\\Windows',
      'WINDIR': 'C:\\Windows', 'TEMP': 'C:\\Users\\User\\AppData\\Local\\Temp',
      'PATH': 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      'HOMEDRIVE': 'C:', 'HOMEPATH': '\\Users\\User',
      'PROCESSOR_ARCHITECTURE': 'AMD64', 'OS': 'Windows_NT',
      'COMSPEC': 'C:\\Windows\\System32\\cmd.exe',
      'PSModulePath': 'C:\\Users\\User\\Documents\\WindowsPowerShell\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules',
    };
    return envMap[varName.toUpperCase()] ?? '';
  }

  private async handleSetContent(args: string[]): Promise<string> {
    let path = '', value = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-Path' && args[i + 1]) { path = args[++i]; }
      else if (args[i] === '-Value' && args[i + 1]) { value = args[++i].replace(/^["']|["']$/g, ''); }
      else if (!path) { path = args[i]; }
    }
    if (path && value) {
      return await this.device.executeCommand(`echo ${value} > ${path}`);
    }
    return '';
  }

  private async handleNewItem(args: string[]): Promise<string> {
    let itemType = 'File', path = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-ItemType' && args[i + 1]) { itemType = args[++i]; }
      else if (args[i] === '-Path' && args[i + 1]) { path = args[++i]; }
      else if (args[i] === '-Name' && args[i + 1]) { path = args[++i]; }
      else if (!args[i].startsWith('-') && !path) { path = args[i]; }
    }
    if (itemType.toLowerCase() === 'directory') {
      return await this.device.executeCommand('mkdir ' + path);
    }
    return await this.device.executeCommand('echo. > ' + path);
  }

  private async handleTestConnection(args: string[]): Promise<string> {
    let target = '', count = '4';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-ComputerName' && args[i + 1]) { target = args[++i]; }
      else if (args[i] === '-Count' && args[i + 1]) { count = args[++i]; }
      else if (!args[i].startsWith('-')) { target = args[i]; }
    }
    if (!target) return "Test-Connection : Parameter 'ComputerName' is required.";

    // Execute the underlying ping to get results
    const pingOutput = await this.device.executeCommand(`ping -n ${count} ${target}`);

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
    const fs = this.device.getFileSystem();
    const target = args.filter(a => !a.startsWith('-')).join(' ');
    if (!target) return 'False';
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
    return await this.device.executeCommand(`echo. > ${filePath}`);
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
      return await this.device.executeCommand(`echo ${value} >> ${filePath}`);
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
    const fs = this.device.getFileSystem();
    const target = args.filter(a => !a.startsWith('-')).join(' ');
    if (!target) return "Get-Item : Cannot bind argument to parameter 'Path' because it is an empty string.";
    const absPath = fs.normalizePath(target, this.cwd);
    const entry = fs.resolve(absPath);
    if (!entry) return `Get-Item : Cannot find path '${target}' because it does not exist.`;

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

  private async executeFallback(cmdline: string): Promise<string> {
    const cmd = cmdline.split(/\s+/)[0];
    try {
      const result = await this.device.executeCommand(cmdline);
      if (result.includes('not recognized')) {
        return `${cmd} : The term '${cmd}' is not recognized as the name of a cmdlet, function, script file, or operable\nprogram. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.\nAt line:1 char:1\n+ ${cmdline}\n+ ${'~'.repeat(cmdline.length)}\n    + CategoryInfo          : ObjectNotFound: (${cmd}:String) [], CommandNotFoundException\n    + FullyQualifiedErrorId : CommandNotFoundException`;
      }
      return result;
    } catch {
      return `${cmd} : The term '${cmd}' is not recognized as the name of a cmdlet, function, script file, or operable\nprogram.`;
    }
  }
}
