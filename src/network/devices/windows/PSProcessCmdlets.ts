/**
 * PowerShell process management cmdlets — matches real PowerShell output exactly.
 *
 * Implements:
 *   - Get-Process [-Name <name>] [-Id <pid>]
 *   - Stop-Process [-Name <name>] [-Id <pid>] [-Force]
 *
 * Uses WindowsProcessManager for dynamic data.
 */

import type { WindowsProcessManager, WindowsProcess } from './WindowsProcessManager';

export interface PSProcessContext {
  processManager: WindowsProcessManager;
  currentUser: string;
  isAdmin: boolean;
}

// ─── Get-Process ─────────────────────────────────────────────────

export function psGetProcess(ctx: PSProcessContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name');
  const id = params.get('id');
  const computerName = params.get('computername');
  const includeUserName = params.has('includeusername');
  const module = params.has('module');

  if (computerName) {
    return `Get-Process : Remoting to a remote computer is not supported in this simulator.\n    + CategoryInfo          : NotImplemented: (:) [Get-Process], NotSupportedException`;
  }

  // -Module: return loaded modules regardless of which process is targeted
  if (module) {
    const moduleList = ['ntdll.dll', 'kernel32.dll', 'user32.dll', 'msvcrt.dll', 'advapi32.dll', 'shell32.dll'];
    return [
      '',
      'ModuleName                BaseAddress        EntryPoint         ModuleMemorySize',
      '----------                -----------        ----------         ----------------',
      ...moduleList.map(m => `${m.padEnd(26)}0x00007ff000000000 0x00007ff000001000 ${(Math.floor(Math.random() * 500) + 100)} KB`),
    ].join('\n');
  }

  let procs: WindowsProcess[];

  if (name) {
    // Support comma-separated or multi-name: "csrss,svchost"
    const names = name.split(',').map(n => n.trim()).filter(Boolean);
    if (names.length > 1) {
      procs = names.flatMap(n => ctx.processManager.getProcessesByName(n));
    } else {
      procs = ctx.processManager.getProcessesByName(name);
      if (procs.length === 0) {
        return `Get-Process : Cannot find a process with the name "${name}". Verify the process name and call the cmdlet\nagain.\n    + CategoryInfo          : ObjectNotFound: (${name}:String) [Get-Process], ProcessCommandException\n    + FullyQualifiedErrorId : NoProcessFoundForGivenName,Microsoft.PowerShell.Commands.GetProcessCommand`;
      }
    }
  } else if (id) {
    const pid = parseInt(id, 10);
    const p = ctx.processManager.getProcess(pid);
    if (!p) return `Get-Process : Cannot find a process with the process identifier ${pid}.\n    + CategoryInfo          : ObjectNotFound: (${pid}:Int32) [Get-Process], ProcessCommandException\n    + FullyQualifiedErrorId : NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand`;
    procs = [p];
  } else {
    procs = ctx.processManager.getAllProcesses();
  }

  return formatProcessTable(procs, includeUserName ? ctx.currentUser : undefined);
}

// ─── Stop-Process ────────────────────────────────────────────────

export function psStopProcess(ctx: PSProcessContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name');
  const id = params.get('id');
  const force = params.has('force');
  const whatIf = params.has('whatif');
  const passThru = params.has('passthru');

  if (passThru) {
    return `Stop-Process : A parameter cannot be found that matches parameter name 'PassThru'.\n    + CategoryInfo          : InvalidArgument: (:) [Stop-Process], ParameterBindingException\n    + FullyQualifiedErrorId : NamedParameterNotFound,Microsoft.PowerShell.Commands.StopProcessCommand`;
  }

  if (name) {
    const procs = ctx.processManager.getProcessesByName(name);
    if (procs.length === 0) {
      return `Stop-Process : Cannot find a process with the name "${name}". Verify the process name and call the\ncmdlet again.\n    + CategoryInfo          : ObjectNotFound: (${name}:String) [Stop-Process], ProcessCommandException\n    + FullyQualifiedErrorId : NoProcessFoundForGivenName,Microsoft.PowerShell.Commands.StopProcessCommand`;
    }
    if (whatIf) {
      return procs.map(p => `What if: Performing the operation "Stop-Process" on target "${p.name} (${p.pid})".`).join('\n');
    }
    const results: string[] = [];
    for (const proc of procs) {
      if (proc.systemOwned && !ctx.isAdmin) {
        results.push(`Stop-Process : Access is denied for process "${proc.name}" (${proc.pid}).`);
        continue;
      }
      if (proc.critical) {
        results.push(`Stop-Process : The process "${proc.name}" (${proc.pid}) is critical and cannot be stopped.`);
        continue;
      }
      ctx.processManager.killProcess(proc.pid, force, ctx.isAdmin);
    }
    return results.length > 0 ? results.join('\n') : '';
  }

  if (id) {
    const pid = parseInt(id, 10);
    const proc = ctx.processManager.getProcess(pid);
    if (!proc) return `Stop-Process : Cannot find a process with the process identifier ${pid}.\n    + CategoryInfo          : ObjectNotFound: (${pid}:Int32) [Stop-Process], ProcessCommandException\n    + FullyQualifiedErrorId : NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.StopProcessCommand`;
    if (proc.systemOwned && !ctx.isAdmin) return `Stop-Process : Access is denied for process "${proc.name}" (${pid}).`;
    if (proc.critical) return `Stop-Process : The process "${proc.name}" (${pid}) is critical and cannot be stopped.`;
    if (whatIf) return `What if: Performing the operation "Stop-Process" on target "${proc.name} (${pid})".`;
    const err = ctx.processManager.killProcess(pid, force, ctx.isAdmin);
    if (err) return `Stop-Process : ${err}`;
    return '';
  }

  return "Stop-Process : Cannot bind parameter. Specify -Name or -Id.";
}

// ─── Build PSObject[] for pipeline support ───────────────────────

export function buildDynamicProcessObjects(ctx: PSProcessContext): Array<Record<string, unknown>> {
  const procs = ctx.processManager.getAllProcesses();
  return procs.map(p => ({
    Handles: p.handles,
    'NPM(K)': p.npmK,
    'PM(K)': Math.floor(p.pmK / 1024),
    'WS(K)': Math.floor(p.wsK),
    'CPU(s)': p.cpuSec,
    Id: p.pid,
    SI: p.sessionId,
    ProcessName: p.name.replace(/\.exe$/i, ''),
  }));
}

// ─── Formatting (matches real PowerShell 5.1 output) ─────────────
// Real PS5.1 Get-Process columns:
//   Handles(7) NPM(K)(6) PM(K)(8) WS(K)(8) CPU(s)(8) Id(6) SI(2) ProcessName

function formatProcessTable(procs: WindowsProcess[], userName?: string): string {
  const lines: string[] = [''];
  const userCol = userName ? '  UserName' : '';
  lines.push(
    'Handles'.padStart(7) + '  ' +
    'NPM(K)'.padStart(6) + '    ' +
    'PM(K)'.padStart(5) + '      ' +
    'WS(K)'.padStart(5) + '     ' +
    'CPU(s)'.padStart(6) + '     ' +
    'Id'.padEnd(2) + '  ' +
    'SI'.padEnd(2) + ' ' +
    'ProcessName' + userCol
  );
  lines.push(
    '-------'.padStart(7) + '  ' +
    '------'.padStart(6) + '    ' +
    '-----'.padStart(5) + '      ' +
    '-----'.padStart(5) + '     ' +
    '------'.padStart(6) + '     ' +
    '--'.padEnd(2) + '  ' +
    '--'.padEnd(2) + ' ' +
    '-----------' + (userName ? '  --------' : '')
  );

  for (const p of procs) {
    const pName = p.name.replace(/\.exe$/i, '');
    lines.push(
      String(p.handles).padStart(7) + '  ' +
      String(p.npmK).padStart(6) + '    ' +
      String(Math.floor(p.pmK / 1024)).padStart(5) + '      ' +
      String(Math.floor(p.wsK)).padStart(5) + '     ' +
      p.cpuSec.toFixed(2).padStart(6) + '   ' +
      String(p.pid).padStart(4) + '   ' +
      String(p.sessionId) + ' ' +
      pName + (userName ? `  ${userName}` : '')
    );
  }
  return lines.join('\n');
}

// ─── Arg parser ──────────────────────────────────────────────────

function parsePSArgs(args: string[]): Map<string, string> {
  const merged: string[] = [];
  let buf = '';
  let inQuote = false;
  for (const tok of args) {
    if (inQuote) {
      buf += ' ' + tok;
      if (tok.endsWith('"') || tok.endsWith("'")) { inQuote = false; merged.push(buf); buf = ''; }
    } else if ((tok.startsWith('"') && !tok.endsWith('"')) || (tok.startsWith("'") && !tok.endsWith("'"))) {
      inQuote = true; buf = tok;
    } else {
      merged.push(tok);
    }
  }
  if (buf) merged.push(buf);

  const result = new Map<string, string>();
  for (let i = 0; i < merged.length; i++) {
    if (merged[i].startsWith('-') && i + 1 < merged.length && !merged[i + 1].startsWith('-')) {
      result.set(merged[i].substring(1).toLowerCase(), merged[i + 1].replace(/^["']|["']$/g, ''));
      i++;
    } else if (merged[i].startsWith('-')) {
      result.set(merged[i].substring(1).toLowerCase(), 'true');
    }
  }
  return result;
}
