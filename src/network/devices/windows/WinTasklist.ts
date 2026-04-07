/**
 * Windows tasklist command — dynamic process listing with filters.
 *
 * Produces output that exactly matches real Windows 10/11 tasklist.exe.
 *
 * Supports:
 *   - tasklist              — basic process list (TABLE format)
 *   - tasklist /SVC         — show services hosted by each process
 *   - tasklist /V           — verbose (username, status, cpu time, window title)
 *   - tasklist /FI "filter" — filter processes
 *   - tasklist /FO format   — output format (TABLE, CSV, LIST)
 *   - tasklist /NH          — no headers (TABLE/CSV only)
 */

import type { WindowsProcessManager, WindowsProcess } from './WindowsProcessManager';

export interface TasklistContext {
  processManager: WindowsProcessManager;
  currentUser: string;
  hostname: string;
}

type OutputFormat = 'TABLE' | 'CSV' | 'LIST';

export function cmdTasklist(ctx: TasklistContext, args: string[]): string {
  let showSvc = false;
  let verbose = false;
  let format: OutputFormat = 'TABLE';
  let noHeader = false;
  const filters: Array<{ field: string; op: string; value: string }> = [];

  for (let i = 0; i < args.length; i++) {
    const flag = args[i].toLowerCase();
    if (flag === '/svc') {
      showSvc = true;
    } else if (flag === '/v') {
      verbose = true;
    } else if (flag === '/nh') {
      noHeader = true;
    } else if (flag === '/fi' && i + 1 < args.length) {
      const filter = parseFilter(args[++i]);
      if (filter) filters.push(filter);
    } else if (flag === '/fo' && i + 1 < args.length) {
      const f = args[++i].toUpperCase();
      if (f === 'CSV' || f === 'LIST' || f === 'TABLE') format = f;
    }
  }

  let processes = ctx.processManager.getAllProcesses();

  for (const f of filters) {
    processes = applyFilter(processes, f, ctx);
  }

  if (processes.length === 0) {
    return 'INFO: No tasks are running which match the specified criteria.';
  }

  if (showSvc) return formatSvc(processes, format, noHeader);
  if (verbose) return formatVerbose(processes, ctx, format, noHeader);
  return formatBasic(processes, format, noHeader);
}

// ─── Filter parsing ──────────────────────────────────────────────

function parseFilter(raw: string): { field: string; op: string; value: string } | null {
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
        if (val.includes('*')) {
          const pattern = val.replace(/\*/g, '.*');
          const re = new RegExp(`^${pattern}$`);
          return filter.op === 'eq' ? re.test(name) : !re.test(name);
        }
        return filter.op === 'eq' ? name === val : name !== val;
      }
      case 'pid': return compareNum(p.pid, parseInt(filter.value, 10), filter.op);
      case 'status': {
        const val = filter.value.toLowerCase();
        return filter.op === 'eq'
          ? p.status.toLowerCase() === val
          : p.status.toLowerCase() !== val;
      }
      case 'username': {
        const owner = resolveOwnerWithHost(ctx, p).toLowerCase();
        const val = filter.value.toLowerCase();
        return filter.op === 'eq' ? owner.includes(val) : !owner.includes(val);
      }
      case 'session': {
        const val = filter.value.toLowerCase();
        return filter.op === 'eq'
          ? p.session.toLowerCase() === val
          : p.session.toLowerCase() !== val;
      }
      case 'memusage': return compareNum(Math.floor(p.wsK), parseInt(filter.value, 10), filter.op);
      case 'services': {
        const svcStr = p.hostedServices.join(',').toLowerCase();
        const val = filter.value.toLowerCase();
        return filter.op === 'eq' ? svcStr.includes(val) : !svcStr.includes(val);
      }
      case 'windowtitle': {
        const title = (p.windowTitle || 'N/A').toLowerCase();
        const val = filter.value.toLowerCase();
        return filter.op === 'eq' ? title.includes(val) : !title.includes(val);
      }
      case 'cputime': {
        const secs = parseCpuTimeFilter(filter.value);
        if (secs === null) return true;
        return compareNum(p.cpuSec, secs, filter.op);
      }
      default: return true;
    }
  });
}

function compareNum(actual: number, expected: number, op: string): boolean {
  switch (op) {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'gt': return actual > expected;
    case 'lt': return actual < expected;
    case 'ge': return actual >= expected;
    case 'le': return actual <= expected;
    default: return true;
  }
}

function parseCpuTimeFilter(val: string): number | null {
  const m = val.match(/^(\d+):(\d+):(\d+)$/);
  if (!m) return null;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
}

// ─── Owner resolution ────────────────────────────────────────────

function resolveOwnerWithHost(ctx: TasklistContext, p: WindowsProcess): string {
  const raw = ctx.processManager.resolveOwner(p, ctx.currentUser);
  if (raw.includes('\\')) return raw;
  return `${ctx.hostname}\\${raw}`;
}

// ─── Memory formatting (matches real Windows: "12,345 K") ────────

function formatMem(kb: number): string {
  return `${Math.floor(kb).toLocaleString('en-US')} K`;
}

// ─── CPU time formatting (H:MM:SS) ──────────────────────────────

function formatCpuTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── Column widths (matching real Windows tasklist.exe) ──────────

const COL_IMAGE = 25;
const COL_PID = 8;
const COL_SESSION = 16;
const COL_SESSNUM = 11;
const COL_MEM = 12;
const COL_STATUS = 15;
const COL_USER = 34;
const COL_CPUTIME = 8;
const COL_WINDOW = 64;
const COL_SERVICES = 44;

// ─── TABLE format — basic ────────────────────────────────────────

function formatBasic(procs: WindowsProcess[], format: OutputFormat, noHeader: boolean): string {
  if (format === 'CSV') return formatBasicCsv(procs, noHeader);
  if (format === 'LIST') return formatBasicList(procs);

  const lines: string[] = [''];
  if (!noHeader) {
    lines.push(
      'Image Name'.padEnd(COL_IMAGE) + ' ' +
      'PID'.padStart(COL_PID) + ' ' +
      'Session Name'.padEnd(COL_SESSION) + ' ' +
      'Session#'.padStart(COL_SESSNUM) + ' ' +
      'Mem Usage'.padStart(COL_MEM)
    );
    lines.push(
      '='.repeat(COL_IMAGE) + ' ' +
      '='.repeat(COL_PID) + ' ' +
      '='.repeat(COL_SESSION) + ' ' +
      '='.repeat(COL_SESSNUM) + ' ' +
      '='.repeat(COL_MEM)
    );
  }

  for (const p of procs) {
    lines.push(
      p.name.padEnd(COL_IMAGE) + ' ' +
      String(p.pid).padStart(COL_PID) + ' ' +
      p.session.padEnd(COL_SESSION) + ' ' +
      String(p.sessionId).padStart(COL_SESSNUM) + ' ' +
      formatMem(p.wsK).padStart(COL_MEM)
    );
  }
  return lines.join('\n');
}

function formatBasicCsv(procs: WindowsProcess[], noHeader: boolean): string {
  const lines: string[] = [];
  if (!noHeader) {
    lines.push('"Image Name","PID","Session Name","Session#","Mem Usage"');
  }
  for (const p of procs) {
    lines.push(`"${p.name}","${p.pid}","${p.session}","${p.sessionId}","${formatMem(p.wsK)}"`);
  }
  return lines.join('\n');
}

function formatBasicList(procs: WindowsProcess[]): string {
  const blocks: string[] = [];
  for (const p of procs) {
    blocks.push([
      `Image Name:   ${p.name}`,
      `PID:          ${p.pid}`,
      `Session Name: ${p.session}`,
      `Session#:     ${p.sessionId}`,
      `Mem Usage:    ${formatMem(p.wsK)}`,
    ].join('\n'));
  }
  return '\n' + blocks.join('\n\n');
}

// ─── /SVC format ─────────────────────────────────────────────────

function formatSvc(procs: WindowsProcess[], format: OutputFormat, noHeader: boolean): string {
  if (format === 'CSV') return formatSvcCsv(procs, noHeader);
  if (format === 'LIST') return formatSvcList(procs);

  const lines: string[] = [''];
  if (!noHeader) {
    lines.push(
      'Image Name'.padEnd(COL_IMAGE) + ' ' +
      'PID'.padStart(COL_PID) + ' ' +
      'Services'
    );
    lines.push(
      '='.repeat(COL_IMAGE) + ' ' +
      '='.repeat(COL_PID) + ' ' +
      '='.repeat(COL_SERVICES)
    );
  }

  for (const p of procs) {
    const svcNames = p.hostedServices.length > 0 ? p.hostedServices.join(', ') : 'N/A';
    lines.push(
      p.name.padEnd(COL_IMAGE) + ' ' +
      String(p.pid).padStart(COL_PID) + ' ' +
      svcNames
    );
  }
  return lines.join('\n');
}

function formatSvcCsv(procs: WindowsProcess[], noHeader: boolean): string {
  const lines: string[] = [];
  if (!noHeader) lines.push('"Image Name","PID","Services"');
  for (const p of procs) {
    const svcNames = p.hostedServices.length > 0 ? p.hostedServices.join(', ') : 'N/A';
    lines.push(`"${p.name}","${p.pid}","${svcNames}"`);
  }
  return lines.join('\n');
}

function formatSvcList(procs: WindowsProcess[]): string {
  const blocks: string[] = [];
  for (const p of procs) {
    const svcNames = p.hostedServices.length > 0 ? p.hostedServices.join(', ') : 'N/A';
    blocks.push([
      `Image Name:   ${p.name}`,
      `PID:          ${p.pid}`,
      `Services:     ${svcNames}`,
    ].join('\n'));
  }
  return '\n' + blocks.join('\n\n');
}

// ─── /V (verbose) format ─────────────────────────────────────────

function formatVerbose(
  procs: WindowsProcess[], ctx: TasklistContext,
  format: OutputFormat, noHeader: boolean
): string {
  if (format === 'CSV') return formatVerboseCsv(procs, ctx, noHeader);
  if (format === 'LIST') return formatVerboseList(procs, ctx);

  const lines: string[] = [''];
  if (!noHeader) {
    lines.push(
      'Image Name'.padEnd(COL_IMAGE) + ' ' +
      'PID'.padStart(COL_PID) + ' ' +
      'Session Name'.padEnd(COL_SESSION) + ' ' +
      'Session#'.padStart(COL_SESSNUM) + ' ' +
      'Mem Usage'.padStart(COL_MEM) + ' ' +
      'Status'.padEnd(COL_STATUS) + ' ' +
      'User Name'.padEnd(COL_USER) + ' ' +
      'CPU Time'.padStart(COL_CPUTIME) + ' ' +
      'Window Title'
    );
    lines.push(
      '='.repeat(COL_IMAGE) + ' ' +
      '='.repeat(COL_PID) + ' ' +
      '='.repeat(COL_SESSION) + ' ' +
      '='.repeat(COL_SESSNUM) + ' ' +
      '='.repeat(COL_MEM) + ' ' +
      '='.repeat(COL_STATUS) + ' ' +
      '='.repeat(COL_USER) + ' ' +
      '='.repeat(COL_CPUTIME) + ' ' +
      '='.repeat(COL_WINDOW)
    );
  }

  for (const p of procs) {
    const owner = resolveOwnerWithHost(ctx, p);
    const windowTitle = p.windowTitle || 'N/A';
    lines.push(
      p.name.padEnd(COL_IMAGE) + ' ' +
      String(p.pid).padStart(COL_PID) + ' ' +
      p.session.padEnd(COL_SESSION) + ' ' +
      String(p.sessionId).padStart(COL_SESSNUM) + ' ' +
      formatMem(p.wsK).padStart(COL_MEM) + ' ' +
      p.status.padEnd(COL_STATUS) + ' ' +
      owner.padEnd(COL_USER) + ' ' +
      formatCpuTime(p.cpuSec).padStart(COL_CPUTIME) + ' ' +
      windowTitle
    );
  }
  return lines.join('\n');
}

function formatVerboseCsv(procs: WindowsProcess[], ctx: TasklistContext, noHeader: boolean): string {
  const lines: string[] = [];
  if (!noHeader) {
    lines.push('"Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"');
  }
  for (const p of procs) {
    const owner = resolveOwnerWithHost(ctx, p);
    const windowTitle = p.windowTitle || 'N/A';
    lines.push(
      `"${p.name}","${p.pid}","${p.session}","${p.sessionId}","${formatMem(p.wsK)}",` +
      `"${p.status}","${owner}","${formatCpuTime(p.cpuSec)}","${windowTitle}"`
    );
  }
  return lines.join('\n');
}

function formatVerboseList(procs: WindowsProcess[], ctx: TasklistContext): string {
  const blocks: string[] = [];
  for (const p of procs) {
    const owner = resolveOwnerWithHost(ctx, p);
    const windowTitle = p.windowTitle || 'N/A';
    blocks.push([
      `Image Name:   ${p.name}`,
      `PID:          ${p.pid}`,
      `Session Name: ${p.session}`,
      `Session#:     ${p.sessionId}`,
      `Mem Usage:    ${formatMem(p.wsK)}`,
      `Status:       ${p.status}`,
      `User Name:    ${owner}`,
      `CPU Time:     ${formatCpuTime(p.cpuSec)}`,
      `Window Title: ${windowTitle}`,
    ].join('\n'));
  }
  return '\n' + blocks.join('\n\n');
}
