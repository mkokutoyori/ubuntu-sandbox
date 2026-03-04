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
    const parts = cmdline.split('|').map(s => s.trim());
    let output = await this.executeSingle(parts[0]) ?? '';

    for (let i = 1; i < parts.length; i++) {
      output = this.applyPipeFilter(output, parts[i]);
    }
    return output;
  }

  private applyPipeFilter(input: string, filter: string): string {
    const filterLower = filter.toLowerCase();

    if (filterLower.startsWith('where-object') || filterLower.startsWith('where') || filterLower.startsWith('?')) {
      return input; // Simplified: pass through
    }
    if (filterLower.startsWith('select-string') || filterLower.startsWith('sls')) {
      const pattern = filter.split(/\s+/).slice(1).join(' ').replace(/['"]/g, '');
      if (pattern) {
        return input.split('\n').filter(l => l.toLowerCase().includes(pattern.toLowerCase())).join('\n');
      }
      return input;
    }
    if (filterLower.startsWith('select-object') || filterLower.startsWith('select')) {
      return input;
    }
    if (filterLower.startsWith('format-table') || filterLower.startsWith('ft')) {
      return input;
    }
    if (filterLower.startsWith('format-list') || filterLower.startsWith('fl')) {
      return input;
    }
    if (filterLower.startsWith('out-string')) {
      return input;
    }
    if (filterLower.startsWith('measure-object') || filterLower.startsWith('measure')) {
      const lineCount = input.split('\n').length;
      return `Count    : ${lineCount}\nAverage  : \nSum      : \nMaximum  : \nMinimum  : \nProperty :`;
    }
    if (filterLower.startsWith('sort-object') || filterLower.startsWith('sort')) {
      const outputLines = input.split('\n');
      outputLines.sort();
      return outputLines.join('\n');
    }
    return input;
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
      return this.formatGetChildItem(await this.device.executeCommand('dir ' + args.join(' ')));
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
      return await this.device.executeCommand('tasklist');
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
      return this.formatGetNetIPConfiguration(await this.device.executeCommand('ipconfig'));
    }

    // Get-NetIPAddress
    if (cmdLower === 'get-netipaddress') {
      return this.formatGetNetIPAddress(await this.device.executeCommand('ipconfig'));
    }

    // Get-NetAdapter
    if (cmdLower === 'get-netadapter') {
      return this.formatGetNetAdapter(await this.device.executeCommand('ipconfig /all'));
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
    return await this.device.executeCommand(`ping -n ${count} ${target}`);
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

  private formatGetChildItem(dirOutput: string): string {
    // For now, return as-is. Can be enhanced to show PS-style table format.
    return dirOutput;
  }

  private formatGetNetIPConfiguration(ipconfigOutput: string): string {
    // For now, return ipconfig output. Can be enhanced to show PS object format.
    return ipconfigOutput;
  }

  private formatGetNetIPAddress(ipconfigOutput: string): string {
    return ipconfigOutput;
  }

  private formatGetNetAdapter(ipconfigAllOutput: string): string {
    return ipconfigAllOutput;
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
