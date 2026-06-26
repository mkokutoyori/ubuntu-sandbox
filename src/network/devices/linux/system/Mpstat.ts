import type { CpuSpec } from '../../host/hardware/CpuSpec';
import type { KernelInfo } from '../../host/identity/KernelInfo';
import type { LinuxProcessManager } from '../LinuxProcessManager';

export interface MpstatArgs {
  intervalSeconds: number | null;
  count: number | null;
  showAllCpus: boolean;
  selectedCpus: number[] | null;
}

export interface MpstatCpuRow {
  label: string;
  usr: number;
  nice: number;
  sys: number;
  iowait: number;
  irq: number;
  soft: number;
  steal: number;
  guest: number;
  gnice: number;
  idle: number;
}

const COLUMNS = ['%usr', '%nice', '%sys', '%iowait', '%irq', '%soft', '%steal', '%guest', '%gnice', '%idle'] as const;

export function parseMpstatArgs(args: string[]): MpstatArgs | { error: string } {
  let intervalSeconds: number | null = null;
  let count: number | null = null;
  let showAllCpus = false;
  let selectedCpus: number[] | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-P') {
      const v = args[++i] ?? '';
      if (!v) return { error: 'mpstat: option -P requires an argument' };
      if (v.toUpperCase() === 'ALL') { showAllCpus = true; continue; }
      const list = v.split(',').map((x) => parseInt(x, 10));
      if (list.some((n) => !Number.isFinite(n) || n < 0)) {
        return { error: `mpstat: invalid -P argument: ${v}` };
      }
      selectedCpus = list;
    } else if (a === '-u' || a === '-A') {
      if (a === '-A') showAllCpus = true;
    } else if (a === '-V' || a === '--version') {
      return { error: 'sysstat version 12.5.2' };
    } else if (a.startsWith('-')) {
      return { error: `mpstat: unknown option: ${a}` };
    } else if (/^\d+$/.test(a)) {
      positional.push(a);
    } else {
      return { error: `mpstat: bad argument: ${a}` };
    }
  }

  if (positional.length >= 1) intervalSeconds = parseInt(positional[0], 10);
  if (positional.length >= 2) count = parseInt(positional[1], 10);
  if (positional.length > 2) return { error: 'mpstat: too many arguments' };

  return { intervalSeconds, count, showAllCpus, selectedCpus };
}

function fmtDateBanner(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${yyyy}`;
}

function fmtTimestamp(d: Date): string {
  const h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${String(h12).padStart(2, '0')}:${mm}:${ss} ${ampm}`;
}

export function mpstatBanner(kernel: KernelInfo, hostname: string, cpu: CpuSpec, now: Date): string {
  return `${kernel.sysname} ${kernel.release} (${hostname})  ${fmtDateBanner(now)}  _${cpu.architecture}_  (${cpu.logicalCpus} CPU)\n`;
}

export function mpstatColumnHeader(now: Date): string {
  const ts = fmtTimestamp(now);
  return `${ts}  CPU` + COLUMNS.map((c) => c.padStart(8)).join('');
}

export function formatMpstatRow(now: Date, row: MpstatCpuRow): string {
  const ts = fmtTimestamp(now);
  return `${ts}  ${row.label.padStart(3)}` + [
    row.usr, row.nice, row.sys, row.iowait, row.irq, row.soft, row.steal, row.guest, row.gnice, row.idle,
  ].map((v) => v.toFixed(2).padStart(8)).join('');
}

export function formatMpstatAverageRow(row: MpstatCpuRow): string {
  return `Average:     ${row.label.padStart(3)}` + [
    row.usr, row.nice, row.sys, row.iowait, row.irq, row.soft, row.steal, row.guest, row.gnice, row.idle,
  ].map((v) => v.toFixed(2).padStart(8)).join('');
}

export function sampleMpstat(args: MpstatArgs, pm: LinuxProcessManager, cpu: CpuSpec): MpstatCpuRow[] {
  const procs = pm.list();
  const runQueue = procs.filter((p) => p.state === 'R').length;
  const cpuCount = cpu.logicalCpus;
  const totalLoadPct = Math.min(100, runQueue * 100);
  const perCpuLoad = totalLoadPct / cpuCount;
  const sysPct = perCpuLoad * 0.4;
  const usrPct = perCpuLoad * 0.6;
  const idlePct = Math.max(0, 100 - usrPct - sysPct);

  const aggregate: MpstatCpuRow = {
    label: 'all',
    usr: usrPct, nice: 0, sys: sysPct, iowait: 0,
    irq: 0, soft: 0, steal: 0, guest: 0, gnice: 0, idle: idlePct,
  };

  if (!args.showAllCpus && !args.selectedCpus) return [aggregate];

  const cpuRows: MpstatCpuRow[] = [aggregate];
  const targets = args.selectedCpus ?? Array.from({ length: cpuCount }, (_, i) => i);
  for (const n of targets) {
    if (n >= cpuCount) continue;
    cpuRows.push({
      label: String(n),
      usr: usrPct, nice: 0, sys: sysPct, iowait: 0,
      irq: 0, soft: 0, steal: 0, guest: 0, gnice: 0, idle: idlePct,
    });
  }
  return cpuRows;
}

export class MpstatAccumulator {
  private readonly sums = new Map<string, MpstatCpuRow & { samples: number }>();

  add(rows: MpstatCpuRow[]): void {
    for (const row of rows) {
      const existing = this.sums.get(row.label);
      if (!existing) {
        this.sums.set(row.label, { ...row, samples: 1 });
        continue;
      }
      existing.usr += row.usr; existing.nice += row.nice; existing.sys += row.sys;
      existing.iowait += row.iowait; existing.irq += row.irq; existing.soft += row.soft;
      existing.steal += row.steal; existing.guest += row.guest; existing.gnice += row.gnice;
      existing.idle += row.idle; existing.samples += 1;
    }
  }

  averages(): MpstatCpuRow[] {
    const rows: MpstatCpuRow[] = [];
    for (const [, sum] of this.sums) {
      const n = sum.samples || 1;
      rows.push({
        label: sum.label,
        usr: sum.usr / n, nice: sum.nice / n, sys: sum.sys / n, iowait: sum.iowait / n,
        irq: sum.irq / n, soft: sum.soft / n, steal: sum.steal / n,
        guest: sum.guest / n, gnice: sum.gnice / n, idle: sum.idle / n,
      });
    }
    return rows;
  }

  sampleCount(): number {
    const first = this.sums.values().next().value;
    return first?.samples ?? 0;
  }
}

export interface MpstatContext {
  pm: LinuxProcessManager;
  cpu: CpuSpec;
  kernel: KernelInfo;
  hostname: string;
}

export function cmdMpstat(args: string[], ctx: MpstatContext): { output: string; exitCode: number } {
  const parsed = parseMpstatArgs(args);
  if ('error' in parsed) return { output: parsed.error, exitCode: parsed.error.startsWith('sysstat') ? 0 : 1 };
  const now = new Date();
  const lines: string[] = [mpstatBanner(ctx.kernel, ctx.hostname, ctx.cpu, now)];
  lines.push(mpstatColumnHeader(now));
  const sample = sampleMpstat(parsed, ctx.pm, ctx.cpu);
  for (const row of sample) lines.push(formatMpstatRow(now, row));
  return { output: lines.join('\n'), exitCode: 0 };
}
