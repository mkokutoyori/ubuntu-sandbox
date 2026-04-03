/**
 * Windows tasklist command — dynamic process listing with filters.
 *
 * Supports:
 *   - tasklist              — basic process list
 *   - tasklist /SVC         — show services hosted by each process
 *   - tasklist /V           — verbose (username, status, cpu time)
 *   - tasklist /FI "filter" — filter processes
 *   - tasklist /FO format   — output format (TABLE, CSV, LIST)
 *
 * Uses WindowsProcessManager for dynamic data instead of hardcoded list.
 */

import type { WindowsProcessManager, WindowsProcess } from './WindowsProcessManager';

export interface TasklistContext {
  processManager: WindowsProcessManager;
  currentUser: string;
  hostname: string;
}

export function cmdTasklist(ctx: TasklistContext, args: string[]): string {
  let showSvc = false;
  let verbose = false;
  const filters: Array<{ field: string; op: string; value: string }> = [];

  for (let i = 0; i < args.length; i++) {
    const flag = args[i].toLowerCase();
    if (flag === '/svc') {
      showSvc = true;
    } else if (flag === '/v') {
      verbose = true;
    } else if (flag === '/fi' && i + 1 < args.length) {
      const filter = parseFilter(args[++i]);
      if (filter) filters.push(filter);
    }
    // /FO is parsed but we always output TABLE for simplicity
  }

  let processes = ctx.processManager.getAllProcesses();

  // Apply filters
  for (const f of filters) {
    processes = applyFilter(processes, f, ctx);
  }

  if (processes.length === 0) {
    return 'INFO: No tasks are running which match the specified criteria.';
  }

  if (showSvc) return formatSvc(processes, ctx);
  if (verbose) return formatVerbose(processes, ctx);
  return formatBasic(processes);
}

function parseFilter(raw: string): { field: string; op: string; value: string } | null {
  // "IMAGENAME eq svchost.exe" or "PID eq 4" or "STATUS eq running"
  const clean = raw.replace(/^["']|["']$/g, '');
  const match = clean.match(/^(\w+)\s+(eq|ne|gt|lt|ge|le)\s+(.+)$/i);
  if (!match) return null;
  return { field: match[1].toLowerCase(), op: match[2].toLowerCase(), value: match[3].trim() };
}

function applyFilter(
  procs: WindowsProcess[],
  filter: { field: string; op: string; value: string },
  ctx: TasklistContext
): WindowsProcess[] {
  return procs.filter(p => {
    switch (filter.field) {
      case 'imagename': {
        const name = p.name.toLowerCase();
        const val = filter.value.toLowerCase();
        return filter.op === 'eq' ? name === val : name !== val;
      }
      case 'pid': {
        const val = parseInt(filter.value, 10);
        switch (filter.op) {
          case 'eq': return p.pid === val;
          case 'ne': return p.pid !== val;
          case 'gt': return p.pid > val;
          case 'lt': return p.pid < val;
          default: return true;
        }
      }
      case 'status': {
        const val = filter.value.toLowerCase();
        return filter.op === 'eq'
          ? p.status.toLowerCase() === val
          : p.status.toLowerCase() !== val;
      }
      case 'username': {
        const owner = ctx.processManager.resolveOwner(p, ctx.currentUser).toLowerCase();
        const val = filter.value.toLowerCase();
        return filter.op === 'eq' ? owner.includes(val) : !owner.includes(val);
      }
      case 'session': {
        const val = filter.value.toLowerCase();
        return filter.op === 'eq'
          ? p.session.toLowerCase() === val
          : p.session.toLowerCase() !== val;
      }
      case 'memusage': {
        const val = parseInt(filter.value, 10);
        const mem = Math.floor(p.wsK);
        switch (filter.op) {
          case 'eq': return mem === val;
          case 'gt': return mem > val;
          case 'lt': return mem < val;
          default: return true;
        }
      }
      default: return true;
    }
  });
}

function formatBasic(procs: WindowsProcess[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(
    'Image Name'.padEnd(25) + ' ' +
    'PID'.padStart(8) + ' ' +
    'Session Name'.padEnd(16) + ' ' +
    'Session#'.padStart(8) + ' ' +
    'Mem Usage'.padStart(12)
  );
  lines.push('=' .repeat(25) + ' ' + '='.repeat(8) + ' ' + '='.repeat(16) + ' ' + '='.repeat(8) + ' ' + '='.repeat(12));

  for (const p of procs) {
    const memStr = formatMem(p.wsK);
    lines.push(
      p.name.padEnd(25) + ' ' +
      String(p.pid).padStart(8) + ' ' +
      p.session.padEnd(16) + ' ' +
      String(p.sessionId).padStart(8) + ' ' +
      memStr.padStart(12)
    );
  }
  return lines.join('\n');
}

function formatSvc(procs: WindowsProcess[], ctx: TasklistContext): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(
    'Image Name'.padEnd(25) + ' ' +
    'PID'.padStart(8) + ' ' +
    'Services'
  );
  lines.push('=' .repeat(25) + ' ' + '='.repeat(8) + ' ' + '='.repeat(40));

  for (const p of procs) {
    const svcNames = p.hostedServices.length > 0 ? p.hostedServices.join(', ') : 'N/A';
    lines.push(
      p.name.padEnd(25) + ' ' +
      String(p.pid).padStart(8) + ' ' +
      svcNames
    );
  }
  return lines.join('\n');
}

function formatVerbose(procs: WindowsProcess[], ctx: TasklistContext): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(
    'Image Name'.padEnd(25) + ' ' +
    'PID'.padStart(8) + ' ' +
    'Session Name'.padEnd(16) + ' ' +
    'Session#'.padStart(8) + ' ' +
    'Mem Usage'.padStart(12) + ' ' +
    'Status'.padEnd(16) + ' ' +
    'User Name'.padEnd(30) + ' ' +
    'CPU Time'.padStart(10)
  );
  lines.push(
    '='.repeat(25) + ' ' + '='.repeat(8) + ' ' + '='.repeat(16) + ' ' +
    '='.repeat(8) + ' ' + '='.repeat(12) + ' ' + '='.repeat(16) + ' ' +
    '='.repeat(30) + ' ' + '='.repeat(10)
  );

  for (const p of procs) {
    const memStr = formatMem(p.wsK);
    const owner = ctx.processManager.resolveOwner(p, ctx.currentUser);
    const cpuStr = formatCpuTime(p.cpuSec);
    lines.push(
      p.name.padEnd(25) + ' ' +
      String(p.pid).padStart(8) + ' ' +
      p.session.padEnd(16) + ' ' +
      String(p.sessionId).padStart(8) + ' ' +
      memStr.padStart(12) + ' ' +
      p.status.padEnd(16) + ' ' +
      owner.padEnd(30) + ' ' +
      cpuStr.padStart(10)
    );
  }
  return lines.join('\n');
}

function formatMem(kb: number): string {
  return `${Math.floor(kb).toLocaleString('en-US')} K`;
}

function formatCpuTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
