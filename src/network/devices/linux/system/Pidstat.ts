import type { CpuSpec } from '../../host/hardware/CpuSpec';
import type { MemoryProfile } from '../../host/hardware/MemoryProfile';
import type { KernelInfo } from '../../host/identity/KernelInfo';
import type { LinuxProcessManager, ProcessInfo } from '../LinuxProcessManager';
import { mpstatBanner } from './Mpstat';

export type PidstatReport = 'cpu' | 'memory';

export interface PidstatArgs {
  intervalSeconds: number | null;
  count: number | null;
  report: PidstatReport;
  selectedPids: number[] | null;
  selfOnly: boolean;
  humanReadable: boolean;
}

export interface PidstatCpuRow {
  uid: number;
  pid: number;
  usr: number;
  system: number;
  guest: number;
  wait: number;
  cpu: number;
  cpuNumber: number;
  command: string;
}

export interface PidstatMemRow {
  uid: number;
  pid: number;
  minfltPerSec: number;
  majfltPerSec: number;
  vszKib: number;
  rssKib: number;
  memPct: number;
  command: string;
}

export type PidstatRow = PidstatCpuRow | PidstatMemRow;

export function parsePidstatArgs(args: string[]): PidstatArgs | { error: string } {
  let intervalSeconds: number | null = null;
  let count: number | null = null;
  let report: PidstatReport = 'cpu';
  let selectedPids: number[] | null = null;
  let selfOnly = false;
  let humanReadable = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-u') report = 'cpu';
    else if (a === '-r') report = 'memory';
    else if (a === '-h') humanReadable = true;
    else if (a === '-p') {
      const v = args[++i] ?? '';
      if (!v) return { error: 'pidstat: option -p requires an argument' };
      if (v.toUpperCase() === 'SELF') { selfOnly = true; continue; }
      if (v.toUpperCase() === 'ALL') { selectedPids = null; continue; }
      const list = v.split(',').map((x) => parseInt(x, 10));
      if (list.some((n) => !Number.isFinite(n) || n <= 0)) {
        return { error: `pidstat: invalid -p argument: ${v}` };
      }
      selectedPids = list;
    } else if (a === '-V' || a === '--version') {
      return { error: 'sysstat version 12.5.2' };
    } else if (a.startsWith('-')) {
      return { error: `pidstat: unknown option: ${a}` };
    } else if (/^\d+$/.test(a)) {
      positional.push(a);
    } else {
      return { error: `pidstat: bad argument: ${a}` };
    }
  }

  if (positional.length >= 1) intervalSeconds = parseInt(positional[0], 10);
  if (positional.length >= 2) count = parseInt(positional[1], 10);
  if (positional.length > 2) return { error: 'pidstat: too many arguments' };

  return { intervalSeconds, count, report, selectedPids, selfOnly, humanReadable };
}

function fmtTimestamp(d: Date): string {
  const h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${String(h12).padStart(2, '0')}:${mm}:${ss} ${ampm}`;
}

export function pidstatBanner(kernel: KernelInfo, hostname: string, cpu: CpuSpec, now: Date): string {
  return mpstatBanner(kernel, hostname, cpu, now);
}

export function pidstatColumnHeader(args: PidstatArgs, now: Date): string {
  const ts = fmtTimestamp(now);
  if (args.report === 'cpu') {
    return `${ts}   UID       PID    %usr %system  %guest   %wait    %CPU   CPU  Command`;
  }
  return `${ts}   UID       PID  minflt/s  majflt/s     VSZ     RSS   %MEM  Command`;
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

export function formatPidstatCpuRow(now: Date, row: PidstatCpuRow): string {
  const ts = fmtTimestamp(now);
  return [
    ts,
    pad(row.uid, 5),
    pad(row.pid, 9),
    row.usr.toFixed(2).padStart(7),
    row.system.toFixed(2).padStart(7),
    row.guest.toFixed(2).padStart(7),
    row.wait.toFixed(2).padStart(7),
    row.cpu.toFixed(2).padStart(7),
    pad(row.cpuNumber, 5),
    `  ${row.command}`,
  ].join(' ');
}

export function formatPidstatMemRow(now: Date, row: PidstatMemRow): string {
  const ts = fmtTimestamp(now);
  return [
    ts,
    pad(row.uid, 5),
    pad(row.pid, 9),
    row.minfltPerSec.toFixed(2).padStart(8),
    row.majfltPerSec.toFixed(2).padStart(8),
    pad(row.vszKib, 7),
    pad(row.rssKib, 7),
    row.memPct.toFixed(2).padStart(6),
    `  ${row.command}`,
  ].join(' ');
}

export function formatPidstatAverageCpuRow(row: PidstatCpuRow): string {
  return [
    'Average:',
    pad(row.uid, 5),
    pad(row.pid, 9),
    row.usr.toFixed(2).padStart(7),
    row.system.toFixed(2).padStart(7),
    row.guest.toFixed(2).padStart(7),
    row.wait.toFixed(2).padStart(7),
    row.cpu.toFixed(2).padStart(7),
    pad(row.cpuNumber, 5),
    `  ${row.command}`,
  ].join(' ');
}

export function formatPidstatAverageMemRow(row: PidstatMemRow): string {
  return [
    'Average:',
    pad(row.uid, 5),
    pad(row.pid, 9),
    row.minfltPerSec.toFixed(2).padStart(8),
    row.majfltPerSec.toFixed(2).padStart(8),
    pad(row.vszKib, 7),
    pad(row.rssKib, 7),
    row.memPct.toFixed(2).padStart(6),
    `  ${row.command}`,
  ].join(' ');
}

function selectProcesses(args: PidstatArgs, pm: LinuxProcessManager, shellPid?: number): ProcessInfo[] {
  let procs = pm.list();
  if (args.selfOnly && shellPid !== undefined) {
    procs = procs.filter((p) => p.pid === shellPid);
  } else if (args.selectedPids) {
    const set = new Set(args.selectedPids);
    procs = procs.filter((p) => set.has(p.pid));
  }
  return procs;
}

export function sampleCpuRows(args: PidstatArgs, pm: LinuxProcessManager, cpu: CpuSpec, shellPid?: number): PidstatCpuRow[] {
  const procs = selectProcesses(args, pm, shellPid);
  const cpuCount = cpu.logicalCpus;
  return procs.map((p) => {
    const perCpu = p.state === 'R' ? 100 / cpuCount : 0;
    return {
      uid: p.uid,
      pid: p.pid,
      usr: perCpu * 0.6,
      system: perCpu * 0.4,
      guest: 0,
      wait: 0,
      cpu: perCpu,
      cpuNumber: p.pid % cpuCount,
      command: p.comm,
    };
  });
}

export function sampleMemoryRows(args: PidstatArgs, pm: LinuxProcessManager, memory: MemoryProfile, shellPid?: number): PidstatMemRow[] {
  const procs = selectProcesses(args, pm, shellPid);
  return procs.map((p) => ({
    uid: p.uid,
    pid: p.pid,
    minfltPerSec: 0,
    majfltPerSec: 0,
    vszKib: p.vsize,
    rssKib: p.rss,
    memPct: memory.totalKib > 0 ? (p.rss / memory.totalKib) * 100 : 0,
    command: p.comm,
  }));
}

export class PidstatAccumulator<R extends PidstatCpuRow | PidstatMemRow> {
  private readonly sums = new Map<number, R & { samples: number }>();
  private readonly kind: 'cpu' | 'memory';

  constructor(kind: 'cpu' | 'memory') { this.kind = kind; }

  add(rows: R[]): void {
    if (this.kind === 'cpu') {
      for (const row of rows as PidstatCpuRow[]) {
        const existing = this.sums.get(row.pid) as (PidstatCpuRow & { samples: number }) | undefined;
        if (!existing) {
          this.sums.set(row.pid, { ...(row as R), samples: 1 });
          continue;
        }
        existing.usr += row.usr; existing.system += row.system;
        existing.guest += row.guest; existing.wait += row.wait; existing.cpu += row.cpu;
        existing.samples += 1;
      }
    } else {
      for (const row of rows as PidstatMemRow[]) {
        const existing = this.sums.get(row.pid) as (PidstatMemRow & { samples: number }) | undefined;
        if (!existing) {
          this.sums.set(row.pid, { ...(row as R), samples: 1 });
          continue;
        }
        existing.minfltPerSec += row.minfltPerSec; existing.majfltPerSec += row.majfltPerSec;
        existing.vszKib = row.vszKib; existing.rssKib = row.rssKib;
        existing.memPct += row.memPct; existing.samples += 1;
      }
    }
  }

  averages(): R[] {
    const out: R[] = [];
    for (const [, sum] of this.sums) {
      const n = sum.samples || 1;
      if (this.kind === 'cpu') {
        const r = sum as PidstatCpuRow & { samples: number };
        out.push({
          uid: r.uid, pid: r.pid, command: r.command, cpuNumber: r.cpuNumber,
          usr: r.usr / n, system: r.system / n,
          guest: r.guest / n, wait: r.wait / n, cpu: r.cpu / n,
        } as unknown as R);
      } else {
        const r = sum as PidstatMemRow & { samples: number };
        out.push({
          uid: r.uid, pid: r.pid, command: r.command,
          minfltPerSec: r.minfltPerSec / n, majfltPerSec: r.majfltPerSec / n,
          vszKib: r.vszKib, rssKib: r.rssKib, memPct: r.memPct / n,
        } as unknown as R);
      }
    }
    return out;
  }

  sampleCount(): number {
    const first = this.sums.values().next().value;
    return first?.samples ?? 0;
  }
}

export interface PidstatContext {
  pm: LinuxProcessManager;
  cpu: CpuSpec;
  memory: MemoryProfile;
  kernel: KernelInfo;
  hostname: string;
  shellPid?: number;
}

export function cmdPidstat(args: string[], ctx: PidstatContext): { output: string; exitCode: number } {
  const parsed = parsePidstatArgs(args);
  if ('error' in parsed) return { output: parsed.error, exitCode: parsed.error.startsWith('sysstat') ? 0 : 1 };
  const now = new Date();
  const lines: string[] = [pidstatBanner(ctx.kernel, ctx.hostname, ctx.cpu, now)];
  lines.push(pidstatColumnHeader(parsed, now));
  if (parsed.report === 'cpu') {
    for (const row of sampleCpuRows(parsed, ctx.pm, ctx.cpu, ctx.shellPid)) {
      lines.push(formatPidstatCpuRow(now, row));
    }
  } else {
    for (const row of sampleMemoryRows(parsed, ctx.pm, ctx.memory, ctx.shellPid)) {
      lines.push(formatPidstatMemRow(now, row));
    }
  }
  return { output: lines.join('\n'), exitCode: 0 };
}
