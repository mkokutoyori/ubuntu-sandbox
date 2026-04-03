/**
 * PowerShell process management cmdlets.
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

export function psGetProcess(ctx: PSProcessContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name');
  const id = params.get('id');

  let procs: WindowsProcess[];

  if (name) {
    procs = ctx.processManager.getProcessesByName(name);
    if (procs.length === 0) {
      return `Get-Process : Cannot find a process with the name "${name}".`;
    }
  } else if (id) {
    const pid = parseInt(id, 10);
    const p = ctx.processManager.getProcess(pid);
    if (!p) return `Get-Process : Cannot find a process with the process identifier ${pid}.`;
    procs = [p];
  } else {
    procs = ctx.processManager.getAllProcesses();
  }

  return formatProcessTable(procs);
}

export function psStopProcess(ctx: PSProcessContext, args: string[]): string {
  const params = parsePSArgs(args);
  const name = params.get('name');
  const id = params.get('id');
  const force = params.has('force');

  if (name) {
    const procs = ctx.processManager.getProcessesByName(name);
    if (procs.length === 0) {
      return `Stop-Process : Cannot find a process with the name "${name}".`;
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
    if (!proc) return `Stop-Process : Cannot find a process with the process identifier ${pid}.`;
    if (proc.systemOwned && !ctx.isAdmin) return `Stop-Process : Access is denied for process "${proc.name}" (${pid}).`;
    if (proc.critical) return `Stop-Process : The process "${proc.name}" (${pid}) is critical and cannot be stopped.`;
    const err = ctx.processManager.killProcess(pid, force, ctx.isAdmin);
    if (err) return `Stop-Process : ${err}`;
    return '';
  }

  return "Stop-Process : Cannot bind parameter. Specify -Name or -Id.";
}

/** Build PSObject[] for pipeline support */
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

function formatProcessTable(procs: WindowsProcess[]): string {
  const lines: string[] = [''];
  lines.push(
    'Handles'.padStart(7) + '  ' +
    'NPM(K)'.padStart(6) + '  ' +
    'PM(K)'.padStart(8) + '  ' +
    'WS(K)'.padStart(8) + '  ' +
    'CPU(s)'.padStart(8) + '  ' +
    'Id'.padStart(6) + '  ' +
    'SI'.padStart(2) + '  ' +
    'ProcessName'
  );
  lines.push(
    '-------'.padStart(7) + '  ' +
    '------'.padStart(6) + '  ' +
    '-----'.padStart(8) + '  ' +
    '-----'.padStart(8) + '  ' +
    '------'.padStart(8) + '  ' +
    '--'.padStart(6) + '  ' +
    '--'.padStart(2) + '  ' +
    '-----------'
  );

  for (const p of procs) {
    const pName = p.name.replace(/\.exe$/i, '');
    lines.push(
      String(p.handles).padStart(7) + '  ' +
      String(p.npmK).padStart(6) + '  ' +
      String(Math.floor(p.pmK / 1024)).padStart(8) + '  ' +
      String(Math.floor(p.wsK)).padStart(8) + '  ' +
      p.cpuSec.toFixed(2).padStart(8) + '  ' +
      String(p.pid).padStart(6) + '  ' +
      String(p.sessionId).padStart(2) + '  ' +
      pName
    );
  }
  return lines.join('\n');
}

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
