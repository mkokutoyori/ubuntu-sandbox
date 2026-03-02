/**
 * WindowsTerminal - Windows CMD + PowerShell Terminal Emulation
 *
 * Realistic Windows terminal experience:
 *   - CMD mode: Classic Command Prompt with C:\Users\User> prompt
 *   - PowerShell mode: Enter via `powershell` command, blue theme, PS prompt
 *   - Dynamic prompt with current working directory (updates after cd)
 *   - Tab auto-completion for commands and file paths
 *   - Command history (Up/Down arrows)
 *   - cls/Clear-Host properly clears the terminal output
 *   - Ctrl+C interrupt, Ctrl+L clear
 *   - Windows-authentic color scheme and Cascadia Mono font
 *   - PowerShell cmdlet mapping to Windows commands
 *   - Shell nesting: powershell from CMD, cmd from PS, exit to return
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Equipment } from '@/network';
type BaseDevice = Equipment;

interface OutputLine {
  id: number;
  text: string;
  type: 'normal' | 'error' | 'warning' | 'prompt' | 'ps-header';
}

interface WindowsTerminalProps {
  device: BaseDevice;
  onRequestClose?: () => void;
  /** Callback to notify parent of shell mode changes (for title bar) */
  onShellModeChange?: (mode: 'cmd' | 'powershell') => void;
}

// Shell stack entry for nesting shells
interface ShellEntry {
  type: 'cmd' | 'powershell';
  cwd: string;
}

let lineId = 0;

// ─── PowerShell Version Table ────────────────────────────────────

const PS_VERSION_TABLE = `
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

const PS_BANNER = `Windows PowerShell
Copyright (C) Microsoft Corporation. All rights reserved.

Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows
`;

export const WindowsTerminal: React.FC<WindowsTerminalProps> = ({ device, onRequestClose, onShellModeChange }) => {
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [tabSuggestions, setTabSuggestions] = useState<string[] | null>(null);
  const [currentPrompt, setCurrentPrompt] = useState('C:\\Users\\User>');
  // Shell mode: 'cmd' or 'powershell'
  const [shellMode, setShellMode] = useState<'cmd' | 'powershell'>('cmd');
  // Shell stack for nesting
  const [shellStack, setShellStack] = useState<ShellEntry[]>([]);
  // PowerShell current location (separate from CMD cwd)
  const [psCwd, setPsCwd] = useState('C:\\Users\\User');

  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Focus on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // Scroll to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [lines, tabSuggestions]);

  // Notify parent of shell mode changes
  useEffect(() => {
    onShellModeChange?.(shellMode);
  }, [shellMode, onShellModeChange]);

  // Add line to output
  const addLine = useCallback((text: string, type: OutputLine['type'] = 'normal') => {
    setLines(prev => [...prev, { id: ++lineId, text, type }]);
  }, []);

  // Add multiple lines
  const addLines = useCallback((text: string, type: OutputLine['type'] = 'normal') => {
    const resultLines = text.split('\n');
    setLines(prev => [
      ...prev,
      ...resultLines.map(l => ({ id: ++lineId, text: l, type })),
    ]);
  }, []);

  // Refresh CMD prompt from device (after cd, cls, etc.)
  const refreshPrompt = useCallback(async () => {
    try {
      const cdResult = await device.executeCommand('cd');
      if (cdResult && !cdResult.includes('not recognized')) {
        const cwd = cdResult.trim();
        setCurrentPrompt(cwd + '>');
        setPsCwd(cwd);
      }
    } catch { /* ignore */ }
  }, [device]);

  // Get the current PS-style prompt
  const getPsPrompt = useCallback(() => {
    return `PS ${psCwd}> `;
  }, [psCwd]);

  // Get the current active prompt
  const getActivePrompt = useCallback(() => {
    return shellMode === 'powershell' ? getPsPrompt() : currentPrompt;
  }, [shellMode, currentPrompt, getPsPrompt]);

  // ─── PowerShell cmdlet execution ───────────────────────────────

  const executePSCmdlet = useCallback(async (cmdline: string): Promise<string | null> => {
    const trimmed = cmdline.trim();
    if (!trimmed) return '';

    // Parse pipeline: support | for filtering
    if (trimmed.includes('|') && !trimmed.match(/[>]/)) {
      const parts = trimmed.split('|').map(s => s.trim());
      let output = await executePSCmdlet(parts[0]) ?? '';
      for (let i = 1; i < parts.length; i++) {
        const filter = parts[i].trim();
        const filterLower = filter.toLowerCase();
        if (filterLower.startsWith('where-object') || filterLower.startsWith('where') || filterLower.startsWith('?')) {
          // Simple Where-Object: just pass through for now
        } else if (filterLower.startsWith('select-string') || filterLower.startsWith('sls')) {
          const pattern = filter.split(/\s+/).slice(1).join(' ').replace(/['"]/g, '');
          if (pattern) {
            output = output.split('\n').filter(l => l.toLowerCase().includes(pattern.toLowerCase())).join('\n');
          }
        } else if (filterLower.startsWith('select-object') || filterLower.startsWith('select')) {
          // Pass through
        } else if (filterLower.startsWith('format-table') || filterLower.startsWith('ft')) {
          // Pass through (already formatted)
        } else if (filterLower.startsWith('format-list') || filterLower.startsWith('fl')) {
          // Pass through
        } else if (filterLower.startsWith('out-string')) {
          // Pass through
        } else if (filterLower.startsWith('measure-object') || filterLower.startsWith('measure')) {
          const lineCount = output.split('\n').length;
          output = `Count    : ${lineCount}\nAverage  : \nSum      : \nMaximum  : \nMinimum  : \nProperty :`;
        } else if (filterLower.startsWith('sort-object') || filterLower.startsWith('sort')) {
          const outputLines = output.split('\n');
          outputLines.sort();
          output = outputLines.join('\n');
        }
      }
      return output;
    }

    // Parse the command
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];
    const cmdLower = cmd.toLowerCase();
    const args = parts.slice(1);

    // ─── PowerShell variables ────────────────────────────────────
    if (cmdLower === '$psversiontable') {
      return PS_VERSION_TABLE;
    }
    if (cmdLower === '$host') {
      return `Name             : ConsoleHost\nVersion          : 5.1.22621.4391\nInstanceId       : ${crypto.randomUUID?.() ?? '00000000-0000-0000-0000-000000000000'}\nUI               : System.Management.Automation.Internal.Host.InternalHostUserInterface\nCurrentCulture   : en-US\nCurrentUICulture : en-US`;
    }
    if (cmdLower === '$pwd') {
      return `\nPath\n----\n${psCwd}\n`;
    }
    if (cmdLower.startsWith('$env:')) {
      const varName = cmd.slice(5);
      // Map common env vars
      const envMap: Record<string, string> = {
        'USERNAME': 'User', 'COMPUTERNAME': device.getHostname(),
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
    if (cmdLower === '$true') return 'True';
    if (cmdLower === '$false') return 'False';
    if (cmdLower === '$null') return '';
    if (cmdLower === '$pid') return String(Math.floor(Math.random() * 10000 + 1000));

    // ─── PowerShell cmdlets → mapped to device commands ──────────

    // Get-ChildItem / ls / dir / gci
    if (cmdLower === 'get-childitem' || cmdLower === 'gci' || cmdLower === 'ls' || cmdLower === 'dir') {
      return await device.executeCommand('dir ' + args.join(' '));
    }

    // Set-Location / cd / sl / chdir
    if (cmdLower === 'set-location' || cmdLower === 'sl' || cmdLower === 'cd' || cmdLower === 'chdir') {
      const target = args.join(' ') || 'C:\\Users\\User';
      const result = await device.executeCommand('cd ' + target);
      // Update PS cwd
      const cdResult = await device.executeCommand('cd');
      if (cdResult && !cdResult.includes('not recognized')) {
        setPsCwd(cdResult.trim());
        setCurrentPrompt(cdResult.trim() + '>');
      }
      return result || '';
    }

    // Get-Location / pwd / gl
    if (cmdLower === 'get-location' || cmdLower === 'gl' || cmdLower === 'pwd') {
      return `\nPath\n----\n${psCwd}\n`;
    }

    // Get-Content / cat / type / gc
    if (cmdLower === 'get-content' || cmdLower === 'gc' || cmdLower === 'cat' || cmdLower === 'type') {
      return await device.executeCommand('type ' + args.join(' '));
    }

    // Set-Content / sc
    if (cmdLower === 'set-content' || cmdLower === 'sc') {
      // Parse: Set-Content -Path file -Value "content"
      let path = '', value = '';
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-Path' && args[i + 1]) { path = args[++i]; }
        else if (args[i] === '-Value' && args[i + 1]) { value = args[++i].replace(/^["']|["']$/g, ''); }
        else if (!path) { path = args[i]; }
      }
      if (path && value) {
        return await device.executeCommand(`echo ${value} > ${path}`);
      }
      return '';
    }

    // New-Item / ni
    if (cmdLower === 'new-item' || cmdLower === 'ni') {
      let itemType = 'File', path = '';
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-ItemType' && args[i + 1]) { itemType = args[++i]; }
        else if (args[i] === '-Path' && args[i + 1]) { path = args[++i]; }
        else if (args[i] === '-Name' && args[i + 1]) { path = args[++i]; }
        else if (!args[i].startsWith('-') && !path) { path = args[i]; }
      }
      if (itemType.toLowerCase() === 'directory') {
        return await device.executeCommand('mkdir ' + path);
      }
      return await device.executeCommand('echo. > ' + path);
    }

    // Remove-Item / ri / rm / rmdir / del
    if (cmdLower === 'remove-item' || cmdLower === 'ri' || cmdLower === 'rm' || cmdLower === 'del' || cmdLower === 'erase') {
      const target = args.filter(a => !a.startsWith('-')).join(' ');
      return await device.executeCommand('del ' + target);
    }

    // Copy-Item / cpi / copy / cp
    if (cmdLower === 'copy-item' || cmdLower === 'cpi' || cmdLower === 'copy' || cmdLower === 'cp') {
      const nonFlags = args.filter(a => !a.startsWith('-'));
      return await device.executeCommand('copy ' + nonFlags.join(' '));
    }

    // Move-Item / mi / move / mv
    if (cmdLower === 'move-item' || cmdLower === 'mi' || cmdLower === 'move' || cmdLower === 'mv') {
      const nonFlags = args.filter(a => !a.startsWith('-'));
      return await device.executeCommand('move ' + nonFlags.join(' '));
    }

    // Rename-Item / rni / ren
    if (cmdLower === 'rename-item' || cmdLower === 'rni' || cmdLower === 'ren') {
      const nonFlags = args.filter(a => !a.startsWith('-'));
      return await device.executeCommand('ren ' + nonFlags.join(' '));
    }

    // Write-Host / Write-Output / echo
    if (cmdLower === 'write-host' || cmdLower === 'write-output' || cmdLower === 'echo') {
      return args.join(' ').replace(/^["']|["']$/g, '');
    }

    // Clear-Host / cls / clear
    if (cmdLower === 'clear-host' || cmdLower === 'cls' || cmdLower === 'clear') {
      return null; // Special: handled by caller
    }

    // Get-Process / gps / ps
    if (cmdLower === 'get-process' || cmdLower === 'gps') {
      return await device.executeCommand('tasklist');
    }

    // Get-Help
    if (cmdLower === 'get-help') {
      const topic = args[0] || '';
      return `TOPIC\n    Windows PowerShell Help System\n\nSHORT DESCRIPTION\n    Displays help about Windows PowerShell cmdlets and concepts.\n\nLONG DESCRIPTION\n    Windows PowerShell Help describes cmdlets, functions, scripts, and modules.\n\n    To get help for a cmdlet, type: Get-Help <cmdlet-name>\n\n${topic ? `Get-Help ${topic}: No help found for topic "${topic}".` : ''}`;
    }

    // Get-Command / gcm
    if (cmdLower === 'get-command' || cmdLower === 'gcm') {
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

    // Get-NetIPConfiguration
    if (cmdLower === 'get-netipconfiguration') {
      return await device.executeCommand('ipconfig');
    }

    // Get-NetIPAddress
    if (cmdLower === 'get-netipaddress') {
      return await device.executeCommand('ipconfig');
    }

    // Get-NetAdapter
    if (cmdLower === 'get-netadapter') {
      return await device.executeCommand('ipconfig /all');
    }

    // Test-Connection (PowerShell ping)
    if (cmdLower === 'test-connection') {
      let target = '';
      let count = '4';
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-ComputerName' && args[i + 1]) { target = args[++i]; }
        else if (args[i] === '-Count' && args[i + 1]) { count = args[++i]; }
        else if (!args[i].startsWith('-')) { target = args[i]; }
      }
      if (!target) return 'Test-Connection : Parameter \'ComputerName\' is required.';
      return await device.executeCommand(`ping -n ${count} ${target}`);
    }

    // Resolve-DnsName
    if (cmdLower === 'resolve-dnsname') {
      return `Resolve-DnsName: DNS resolution is not available in this simulation.`;
    }

    // Get-Date
    if (cmdLower === 'get-date') {
      const now = new Date();
      return now.toString();
    }

    // Get-History / h / history
    if (cmdLower === 'get-history' || cmdLower === 'h' || cmdLower === 'history') {
      if (history.length === 0) return '';
      return history.map((h, i) => `  ${i + 1}  ${h}`).join('\n');
    }

    // hostname
    if (cmdLower === 'hostname') {
      return device.getHostname();
    }

    // ipconfig (also works in PS)
    if (cmdLower === 'ipconfig') {
      return await device.executeCommand('ipconfig ' + args.join(' '));
    }

    // ping (also works in PS)
    if (cmdLower === 'ping') {
      return await device.executeCommand('ping ' + args.join(' '));
    }

    // netsh (also works in PS)
    if (cmdLower === 'netsh') {
      return await device.executeCommand('netsh ' + args.join(' '));
    }

    // tracert (also works in PS)
    if (cmdLower === 'tracert') {
      return await device.executeCommand('tracert ' + args.join(' '));
    }

    // route (also works in PS)
    if (cmdLower === 'route') {
      return await device.executeCommand('route ' + args.join(' '));
    }

    // arp (also works in PS)
    if (cmdLower === 'arp') {
      return await device.executeCommand('arp ' + args.join(' '));
    }

    // systeminfo
    if (cmdLower === 'systeminfo') {
      return await device.executeCommand('systeminfo');
    }

    // ver
    if (cmdLower === 'ver') {
      return await device.executeCommand('ver');
    }

    // Get-ExecutionPolicy
    if (cmdLower === 'get-executionpolicy') {
      return 'RemoteSigned';
    }

    // Set-ExecutionPolicy
    if (cmdLower === 'set-executionpolicy') {
      return '';
    }

    // Get-Service / gsv
    if (cmdLower === 'get-service' || cmdLower === 'gsv') {
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

    // Get-WmiObject / gwmi (deprecated but still used)
    if (cmdLower === 'get-wmiobject' || cmdLower === 'gwmi' || cmdLower === 'get-ciminstance') {
      const className = args.find(a => !a.startsWith('-')) || '';
      if (className.toLowerCase() === 'win32_operatingsystem') {
        return `SystemDirectory : C:\\Windows\\system32\nOrganization    : \nBuildNumber     : 22631\nRegisteredUser  : User\nSerialNumber    : 00000-00000-00000-AA000\nVersion         : 10.0.22631`;
      }
      if (className.toLowerCase() === 'win32_computersystem') {
        return `Domain              : WORKGROUP\nManufacturer        : Microsoft Corporation\nModel               : Virtual Machine\nName                : ${device.getHostname()}\nPrimaryOwnerName    : User\nTotalPhysicalMemory : 8589934592`;
      }
      return `Get-CimInstance : Invalid class "${className}"`;
    }

    // If nothing matched, try passing to device as-is (for CMD-compatible commands)
    try {
      const result = await device.executeCommand(trimmed);
      // If device says "not recognized", format as PS error
      if (result.includes('not recognized')) {
        return `${cmd} : The term '${cmd}' is not recognized as the name of a cmdlet, function, script file, or operable\nprogram. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.\nAt line:1 char:1\n+ ${trimmed}\n+ ${'~'.repeat(trimmed.length)}\n    + CategoryInfo          : ObjectNotFound: (${cmd}:String) [], CommandNotFoundException\n    + FullyQualifiedErrorId : CommandNotFoundException`;
      }
      return result;
    } catch {
      return `${cmd} : The term '${cmd}' is not recognized as the name of a cmdlet, function, script file, or operable\nprogram.`;
    }
  }, [device, psCwd, history]);

  // ─── Enter PowerShell mode ─────────────────────────────────────

  const enterPowerShell = useCallback(async () => {
    // Push current shell onto stack
    setShellStack(prev => [...prev, { type: shellMode, cwd: currentPrompt }]);
    setShellMode('powershell');
    // Show PowerShell banner
    addLines(PS_BANNER, 'ps-header');
  }, [shellMode, currentPrompt, addLines]);

  // ─── Exit current shell ────────────────────────────────────────

  const exitCurrentShell = useCallback(() => {
    if (shellStack.length > 0) {
      // Pop back to previous shell
      const prev = shellStack[shellStack.length - 1];
      setShellStack(s => s.slice(0, -1));
      setShellMode(prev.type);
      setCurrentPrompt(prev.cwd);
      return true; // Handled: stayed in terminal
    }
    return false; // Not handled: close terminal
  }, [shellStack]);

  // Execute command
  const executeCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();
    const prompt = getActivePrompt();

    // Clear tab suggestions
    setTabSuggestions(null);

    // Echo command with prompt
    addLine(`${prompt}${cmd}`, 'prompt');

    if (!trimmed) {
      setInput('');
      return;
    }

    // Handle exit
    if (trimmed.toLowerCase() === 'exit') {
      if (!exitCurrentShell()) {
        onRequestClose?.();
      }
      setInput('');
      return;
    }

    // Add to history
    setHistory(prev => [...prev.slice(-199), trimmed]);
    setHistoryIndex(-1);

    // ── CMD mode ──
    if (shellMode === 'cmd') {
      // Detect PowerShell launch
      const lower = trimmed.toLowerCase();
      if (lower === 'powershell' || lower === 'powershell.exe' || lower === 'pwsh' || lower === 'pwsh.exe') {
        setInput('');
        await enterPowerShell();
        return;
      }

      // Handle cls — clear terminal
      if (lower === 'cls') {
        setLines([]);
        setInput('');
        await refreshPrompt();
        return;
      }

      // Execute on device
      try {
        const result = await device.executeCommand(trimmed);
        if (result !== undefined && result !== null && result !== '') {
          addLines(result);
        }
        // Update prompt after directory-changing commands
        if (lower.startsWith('cd ') || lower.startsWith('cd\\') || lower === 'cd' || lower.startsWith('chdir')) {
          await refreshPrompt();
        }
      } catch (err) {
        addLine(`Error: ${err}`, 'error');
      }

      setInput('');
      return;
    }

    // ── PowerShell mode ──
    const lower = trimmed.toLowerCase();

    // Detect 'cmd' or 'cmd.exe' to switch to CMD from PS
    if (lower === 'cmd' || lower === 'cmd.exe') {
      setShellStack(prev => [...prev, { type: 'powershell', cwd: currentPrompt }]);
      setShellMode('cmd');
      addLines('Microsoft Windows [Version 10.0.22631.6649]\n(c) Microsoft Corporation. All rights reserved.');
      setInput('');
      return;
    }

    // Handle Clear-Host / cls / clear
    if (lower === 'clear-host' || lower === 'cls' || lower === 'clear') {
      setLines([]);
      setInput('');
      return;
    }

    // Execute PowerShell cmdlet
    const result = await executePSCmdlet(trimmed);
    if (result !== null && result !== undefined && result !== '') {
      addLines(result);
    }

    // Update PS cwd after location changes
    if (lower.startsWith('set-location') || lower.startsWith('sl ') || lower.startsWith('cd ') || lower === 'cd') {
      const cdResult = await device.executeCommand('cd');
      if (cdResult && !cdResult.includes('not recognized')) {
        setPsCwd(cdResult.trim());
        setCurrentPrompt(cdResult.trim() + '>');
      }
    }

    setInput('');
  }, [device, shellMode, getActivePrompt, addLine, addLines, onRequestClose, enterPowerShell, exitCurrentShell, refreshPrompt, executePSCmdlet, currentPrompt]);

  // Tab completion
  const handleTab = useCallback(() => {
    if (!('getCompletions' in device) || typeof (device as any).getCompletions !== 'function') {
      return;
    }

    // In PowerShell mode, add PS cmdlets to completions
    if (shellMode === 'powershell') {
      const parts = input.trimStart().split(/\s+/);
      if (parts.length <= 1) {
        const prefix = (parts[0] || '').toLowerCase();
        const psCmdlets = [
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
        const matches = psCmdlets.filter(c => c.toLowerCase().startsWith(prefix));
        if (matches.length === 1) {
          setInput(matches[0] + ' ');
          setTabSuggestions(null);
        } else if (matches.length > 1) {
          setTabSuggestions(matches.slice(0, 20));
        }
        return;
      }
    }

    // Fall back to device completions for file paths
    const completions: string[] = (device as any).getCompletions(input);
    if (completions.length === 0) return;

    if (completions.length === 1) {
      const parts = input.trimStart().split(/\s+/);
      if (parts.length <= 1) {
        setInput(completions[0] + ' ');
      } else {
        const lastArg = parts[parts.length - 1];
        const lastSep = lastArg.lastIndexOf('\\');
        if (lastSep >= 0) {
          parts[parts.length - 1] = lastArg.substring(0, lastSep + 1) + completions[0];
        } else {
          parts[parts.length - 1] = completions[0];
        }
        setInput(parts.join(' '));
      }
      setTabSuggestions(null);
    } else {
      let common = completions[0];
      for (let i = 1; i < completions.length; i++) {
        while (common && !completions[i].toLowerCase().startsWith(common.toLowerCase())) {
          common = common.slice(0, -1);
        }
      }
      const parts = input.trimStart().split(/\s+/);
      const word = parts[parts.length - 1] || '';
      if (common.length > word.length) {
        if (parts.length <= 1) {
          setInput(common);
        } else {
          parts[parts.length - 1] = common;
          setInput(parts.join(' '));
        }
        setTabSuggestions(null);
      } else {
        setTabSuggestions(completions);
      }
    }
  }, [device, input, shellMode]);

  // Keyboard handling
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Tab') {
      setTabSuggestions(null);
    }

    if (e.key === 'Enter') {
      executeCommand(input);
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      handleTab();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(idx);
      setInput(history[idx] || '');
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;
      const idx = historyIndex + 1;
      if (idx >= history.length) {
        setHistoryIndex(-1);
        setInput('');
      } else {
        setHistoryIndex(idx);
        setInput(history[idx] || '');
      }
      return;
    }

    // Ctrl+C — abort
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      addLine(`${getActivePrompt()}${input}^C`, 'warning');
      setInput('');
    }

    // Ctrl+L — clear screen
    if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    }

    // Escape — clear input
    if (e.key === 'Escape') {
      setInput('');
      setTabSuggestions(null);
    }
  }, [input, history, historyIndex, getActivePrompt, addLine, executeCommand, handleTab]);

  // ─── Render ────────────────────────────────────────────────────

  const isPowerShell = shellMode === 'powershell';

  // Color scheme depends on active shell
  const bgColor = isPowerShell ? '#012456' : '#0c0c0c';
  const textColor = isPowerShell ? '#eeedf0' : '#cccccc';
  const promptColor = isPowerShell ? '#eeedf0' : '#cccccc';

  return (
    <div
      className="h-full w-full flex flex-col text-sm"
      style={{
        backgroundColor: bgColor,
        color: textColor,
        fontFamily: "'Cascadia Mono', 'Consolas', 'Courier New', monospace",
      }}
    >
      {/* Terminal output area */}
      <div
        ref={terminalRef}
        className="flex-1 overflow-auto px-2 py-1"
        style={{
          backgroundColor: bgColor,
          lineHeight: '1.25',
        }}
        onClick={() => inputRef.current?.focus()}
      >
        {/* Banner: only show CMD banner if we started in CMD mode */}
        {!isPowerShell && shellStack.length === 0 && (
          <>
            <pre
              className="whitespace-pre-wrap"
              style={{ color: textColor, margin: 0, fontFamily: 'inherit', lineHeight: '1.25' }}
            >
              {'Microsoft Windows [Version 10.0.22631.6649]\n(c) Microsoft Corporation. All rights reserved.'}
            </pre>
            <div style={{ height: '1.25em' }} />
          </>
        )}

        {/* Output lines */}
        {lines.map((line) => (
          <pre
            key={line.id}
            className="whitespace-pre-wrap"
            style={{
              margin: 0,
              fontFamily: 'inherit',
              lineHeight: '1.25',
              color:
                line.type === 'error' ? (isPowerShell ? '#f85149' : '#f14c4c') :
                line.type === 'warning' ? (isPowerShell ? '#d29922' : '#cca700') :
                line.type === 'ps-header' ? '#eeedf0' :
                textColor,
            }}
          >
            {line.text}
          </pre>
        ))}

        {/* Tab completion suggestions */}
        {tabSuggestions && (
          <pre style={{
            margin: 0,
            fontFamily: 'inherit',
            lineHeight: '1.25',
            color: isPowerShell ? '#9ca0b0' : '#808080',
            paddingTop: '2px',
          }}>
            {tabSuggestions.join('  ')}
          </pre>
        )}

        {/* Active input line */}
        <div className="flex items-center" style={{ minHeight: '1.25em' }}>
          <span
            className="whitespace-pre select-none"
            style={{ color: promptColor, fontFamily: 'inherit' }}
          >
            {getActivePrompt()}
          </span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent outline-none border-none p-0 m-0"
            style={{
              color: textColor,
              caretColor: textColor,
              fontFamily: 'inherit',
              fontSize: 'inherit',
              lineHeight: '1.25',
            }}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>
    </div>
  );
};

export default WindowsTerminal;
