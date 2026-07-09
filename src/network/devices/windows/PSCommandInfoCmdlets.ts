import { parsePSArgs } from './psArgs';

export interface PSCommandContext {
  sessionFunctions: Map<string, { params: string[]; body: string }>;
}

export const BUILTIN_MODULES: Array<{ Name: string; Version: string; ModuleType: string; ExportedCommands: string[] }> = [
    { Name: 'Microsoft.PowerShell.Core',           Version: '3.0.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-Command', 'Get-Help', 'Get-Module', 'Get-History', 'Clear-History', 'ForEach-Object', 'Where-Object', 'Select-Object', 'Measure-Object', 'Sort-Object', 'Group-Object', 'Out-Default', 'Out-Host', 'Out-Null', 'Out-String', 'Tee-Object', 'Import-Module'] },
    { Name: 'Microsoft.PowerShell.Management',     Version: '3.1.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-ChildItem', 'Get-Content', 'Get-Item', 'Get-ItemProperty', 'Get-Location', 'Set-Location', 'Push-Location', 'Pop-Location', 'Set-Content', 'Add-Content', 'Copy-Item', 'Move-Item', 'Rename-Item', 'Remove-Item', 'New-Item', 'Test-Path', 'Get-Process', 'Stop-Process', 'Start-Process', 'Get-Service', 'Start-Service', 'Stop-Service', 'Restart-Service'] },
    { Name: 'Microsoft.PowerShell.Utility',        Version: '3.1.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-Date', 'Write-Host', 'Write-Output', 'Write-Error', 'Write-Warning', 'Format-List', 'Format-Table', 'ConvertTo-Json', 'ConvertFrom-Json', 'Select-String', 'Compare-Object', 'Start-Sleep', 'New-TimeSpan'] },
    { Name: 'Microsoft.PowerShell.LocalAccounts',  Version: '1.0.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-LocalUser', 'New-LocalUser', 'Set-LocalUser', 'Remove-LocalUser', 'Add-LocalGroupMember', 'Get-LocalGroup', 'New-LocalGroup'] },
    { Name: 'NetTCPIP',                            Version: '1.0.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-NetIPAddress', 'New-NetIPAddress', 'Remove-NetIPAddress', 'Set-NetIPAddress', 'Get-NetIPConfiguration', 'Get-NetRoute', 'New-NetRoute', 'Remove-NetRoute'] },
    { Name: 'NetAdapter',                          Version: '2.0.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-NetAdapter', 'Disable-NetAdapter', 'Enable-NetAdapter', 'Rename-NetAdapter'] },
    { Name: 'DnsClient',                           Version: '1.0.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-DnsClientServerAddress', 'Set-DnsClientServerAddress', 'Resolve-DnsName', 'Clear-DnsClientCache'] },
    { Name: 'Storage',                             Version: '2.0.0.0', ModuleType: 'Manifest', ExportedCommands: ['Get-Disk', 'Get-Partition', 'Get-Volume', 'Initialize-Disk', 'New-Partition', 'Format-Volume'] },
  ];

const ALL_COMMANDS: Array<{ type: string; name: string; version: string; source: string; noun: string }> = [
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

export function handleGetCommand(ctx: PSCommandContext, args: string[]): string {
    const params = parsePSArgs(args);
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
      const found = ALL_COMMANDS.filter(c => names.includes(c.name.toLowerCase()));
      if (found.length === 0) {
        // Check for user-defined functions
        const userFuncs = names.filter(n => ctx.sessionFunctions.has(n));
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

    let filtered = [...ALL_COMMANDS];

    // Add user-defined functions
    for (const [name] of ctx.sessionFunctions) {
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
      const moduleExists = BUILTIN_MODULES.some(m => m.Name.toLowerCase().includes(moduleFilter));
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

export function handleGetModule(ctx: PSCommandContext, args: string[]): string {
    const params = parsePSArgs(args);
    const listAvailable = params.has('listavailable');
    const nameFilter = (params.get('name') ?? params.get('_positional') ?? '').toLowerCase();

    const modules = listAvailable ? BUILTIN_MODULES : BUILTIN_MODULES.slice(0, 3);
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
