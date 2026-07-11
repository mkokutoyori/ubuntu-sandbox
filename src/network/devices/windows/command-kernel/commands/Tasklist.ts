import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { ProcessInfo } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

type OutputFormat = 'TABLE' | 'CSV' | 'LIST';

const COL_IMAGE = 25;
const COL_PID = 8;
const COL_SESSION = 16;
const COL_SESSNUM = 11;
const COL_MEM = 12;
const COL_STATUS = 15;
const COL_USER = 34;
const COL_CPUTIME = 8;
const COL_SERVICES = 44;

function formatMem(kib: number): string {
  return `${Math.floor(kib).toLocaleString('en-US')} K`;
}

function formatCpuTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseFilter(raw: string): { field: string; op: string; value: string } | null {
  const clean = raw.replace(/^["']|["']$/g, '');
  const match = clean.match(/^(\w+)\s+(eq|ne|gt|lt|ge|le)\s+(.+)$/i);
  if (!match) return null;
  return { field: match[1].toLowerCase(), op: match[2].toLowerCase(), value: match[3].trim() };
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

function applyFilter(procs: ProcessInfo[], filter: { field: string; op: string; value: string }): ProcessInfo[] {
  return procs.filter((p) => {
    switch (filter.field) {
      case 'imagename': {
        const name = p.command.toLowerCase();
        const val = filter.value.toLowerCase();
        if (val.includes('*')) {
          const re = new RegExp(`^${val.replace(/\*/g, '.*')}$`);
          return filter.op === 'eq' ? re.test(name) : !re.test(name);
        }
        return filter.op === 'eq' ? name === val : name !== val;
      }
      case 'pid': return compareNum(p.pid, parseInt(filter.value, 10), filter.op);
      case 'status': {
        const val = filter.value.toLowerCase();
        const status = (p.status ?? '').toLowerCase();
        return filter.op === 'eq' ? status === val : status !== val;
      }
      case 'username': {
        const owner = (p.ownerName ?? '').toLowerCase();
        const val = filter.value.toLowerCase();
        return filter.op === 'eq' ? owner.includes(val) : !owner.includes(val);
      }
      case 'session': {
        const val = filter.value.toLowerCase();
        const session = (p.sessionName ?? '').toLowerCase();
        return filter.op === 'eq' ? session === val : session !== val;
      }
      case 'memusage': return compareNum(Math.floor(p.memoryKib ?? 0), parseInt(filter.value, 10), filter.op);
      case 'services': {
        const svcStr = (p.hostedServices ?? []).join(',').toLowerCase();
        const val = filter.value.toLowerCase();
        return filter.op === 'eq' ? svcStr.includes(val) : !svcStr.includes(val);
      }
      case 'windowtitle': {
        const title = (p.windowTitle || 'N/A').toLowerCase();
        const val = filter.value.toLowerCase();
        return filter.op === 'eq' ? title.includes(val) : !title.includes(val);
      }
      case 'cputime': {
        const m = filter.value.match(/^(\d+):(\d+):(\d+)$/);
        if (!m) return true;
        const secs = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
        return compareNum(p.cpuSeconds ?? 0, secs, filter.op);
      }
      default: return true;
    }
  });
}

function formatBasic(procs: ProcessInfo[], format: OutputFormat, noHeader: boolean): string {
  if (format === 'CSV') {
    const lines: string[] = [];
    if (!noHeader) lines.push('"Image Name","PID","Session Name","Session#","Mem Usage"');
    for (const p of procs) lines.push(`"${p.command}","${p.pid}","${p.sessionName ?? ''}","${p.sessionNumber ?? 0}","${formatMem(p.memoryKib ?? 0)}"`);
    return lines.join('\n');
  }
  if (format === 'LIST') {
    return '\n' + procs.map((p) => [
      `Image Name:   ${p.command}`,
      `PID:          ${p.pid}`,
      `Session Name: ${p.sessionName ?? ''}`,
      `Session#:     ${p.sessionNumber ?? 0}`,
      `Mem Usage:    ${formatMem(p.memoryKib ?? 0)}`,
    ].join('\n')).join('\n\n');
  }

  const lines: string[] = [''];
  if (!noHeader) {
    lines.push('Image Name'.padEnd(COL_IMAGE) + ' ' + 'PID'.padStart(COL_PID) + ' ' + 'Session Name'.padEnd(COL_SESSION) + ' ' + 'Session#'.padStart(COL_SESSNUM) + ' ' + 'Mem Usage'.padStart(COL_MEM));
    lines.push('='.repeat(COL_IMAGE) + ' ' + '='.repeat(COL_PID) + ' ' + '='.repeat(COL_SESSION) + ' ' + '='.repeat(COL_SESSNUM) + ' ' + '='.repeat(COL_MEM));
  }
  for (const p of procs) {
    lines.push(p.command.padEnd(COL_IMAGE) + ' ' + String(p.pid).padStart(COL_PID) + ' ' + (p.sessionName ?? '').padEnd(COL_SESSION) + ' ' + String(p.sessionNumber ?? 0).padStart(COL_SESSNUM) + ' ' + formatMem(p.memoryKib ?? 0).padStart(COL_MEM));
  }
  return lines.join('\n');
}

function formatSvc(procs: ProcessInfo[], format: OutputFormat, noHeader: boolean): string {
  if (format === 'CSV') {
    const lines: string[] = [];
    if (!noHeader) lines.push('"Image Name","PID","Services"');
    for (const p of procs) lines.push(`"${p.command}","${p.pid}","${(p.hostedServices ?? []).join(', ') || 'N/A'}"`);
    return lines.join('\n');
  }
  if (format === 'LIST') {
    return '\n' + procs.map((p) => [
      `Image Name:   ${p.command}`,
      `PID:          ${p.pid}`,
      `Services:     ${(p.hostedServices ?? []).join(', ') || 'N/A'}`,
    ].join('\n')).join('\n\n');
  }

  const lines: string[] = [''];
  if (!noHeader) {
    lines.push('Image Name'.padEnd(COL_IMAGE) + ' ' + 'PID'.padStart(COL_PID) + ' ' + 'Services');
    lines.push('='.repeat(COL_IMAGE) + ' ' + '='.repeat(COL_PID) + ' ' + '='.repeat(COL_SERVICES));
  }
  for (const p of procs) {
    lines.push(p.command.padEnd(COL_IMAGE) + ' ' + String(p.pid).padStart(COL_PID) + ' ' + ((p.hostedServices ?? []).join(', ') || 'N/A'));
  }
  return lines.join('\n');
}

function formatVerbose(procs: ProcessInfo[], format: OutputFormat, noHeader: boolean): string {
  if (format === 'CSV') {
    const lines: string[] = [];
    if (!noHeader) lines.push('"Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"');
    for (const p of procs) {
      lines.push(`"${p.command}","${p.pid}","${p.sessionName ?? ''}","${p.sessionNumber ?? 0}","${formatMem(p.memoryKib ?? 0)}",` +
        `"${p.status ?? ''}","${p.ownerName ?? ''}","${formatCpuTime(p.cpuSeconds ?? 0)}","${p.windowTitle || 'N/A'}"`);
    }
    return lines.join('\n');
  }
  if (format === 'LIST') {
    return '\n' + procs.map((p) => [
      `Image Name:   ${p.command}`,
      `PID:          ${p.pid}`,
      `Session Name: ${p.sessionName ?? ''}`,
      `Session#:     ${p.sessionNumber ?? 0}`,
      `Mem Usage:    ${formatMem(p.memoryKib ?? 0)}`,
      `Status:       ${p.status ?? ''}`,
      `User Name:    ${p.ownerName ?? ''}`,
      `CPU Time:     ${formatCpuTime(p.cpuSeconds ?? 0)}`,
      `Window Title: ${p.windowTitle || 'N/A'}`,
    ].join('\n')).join('\n\n');
  }

  const lines: string[] = [''];
  if (!noHeader) {
    lines.push('Image Name'.padEnd(COL_IMAGE) + ' ' + 'PID'.padStart(COL_PID) + ' ' + 'Session Name'.padEnd(COL_SESSION) + ' ' + 'Session#'.padStart(COL_SESSNUM) + ' ' + 'Mem Usage'.padStart(COL_MEM) + ' ' + 'Status'.padEnd(COL_STATUS) + ' ' + 'User Name'.padEnd(COL_USER) + ' ' + 'CPU Time'.padStart(COL_CPUTIME) + ' ' + 'Window Title');
    lines.push('='.repeat(COL_IMAGE) + ' ' + '='.repeat(COL_PID) + ' ' + '='.repeat(COL_SESSION) + ' ' + '='.repeat(COL_SESSNUM) + ' ' + '='.repeat(COL_MEM) + ' ' + '='.repeat(COL_STATUS) + ' ' + '='.repeat(COL_USER) + ' ' + '='.repeat(COL_CPUTIME) + ' ' + '='.repeat(64));
  }
  for (const p of procs) {
    lines.push(
      p.command.padEnd(COL_IMAGE) + ' ' + String(p.pid).padStart(COL_PID) + ' ' + (p.sessionName ?? '').padEnd(COL_SESSION) + ' ' +
      String(p.sessionNumber ?? 0).padStart(COL_SESSNUM) + ' ' + formatMem(p.memoryKib ?? 0).padStart(COL_MEM) + ' ' + (p.status ?? '').padEnd(COL_STATUS) + ' ' +
      (p.ownerName ?? '').padEnd(COL_USER) + ' ' + formatCpuTime(p.cpuSeconds ?? 0).padStart(COL_CPUTIME) + ' ' + (p.windowTitle || 'N/A'),
    );
  }
  return lines.join('\n');
}

export class TasklistCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'tasklist',
    summary: 'Liste les processus en cours',
    usage: 'tasklist [/svc] [/v] [/fi filtre] [/fo format]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options tasklist' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];

    let showSvc = false;
    let verbose = false;
    let format: OutputFormat = 'TABLE';
    let noHeader = false;
    const filters: Array<{ field: string; op: string; value: string }> = [];

    for (let i = 0; i < args.length; i++) {
      const flag = args[i].toLowerCase();
      if (flag === '/svc') showSvc = true;
      else if (flag === '/v') verbose = true;
      else if (flag === '/nh') noHeader = true;
      else if (flag === '/fi' && i + 1 < args.length) { const f = parseFilter(args[++i]); if (f) filters.push(f); }
      else if (flag === '/fo' && i + 1 < args.length) { const f = args[++i].toUpperCase(); if (f === 'CSV' || f === 'LIST' || f === 'TABLE') format = f as OutputFormat; }
    }

    let processes = await ctx.machine.proc.list();
    for (const f of filters) processes = applyFilter(processes, f);

    if (processes.length === 0) {
      await ctx.io.stdout.write('INFO: No tasks are running which match the specified criteria.\n');
      return EXIT_OK;
    }

    const output = showSvc ? formatSvc(processes, format, noHeader) : verbose ? formatVerbose(processes, format, noHeader) : formatBasic(processes, format, noHeader);
    await ctx.io.stdout.write(output + '\n');
    return EXIT_OK;
  }
}
