import type { CpuSpec } from '../../host/hardware/CpuSpec';
import type { StorageDevice } from '../../host/hardware/StorageDevice';
import type { KernelInfo } from '../../host/identity/KernelInfo';
import type { LinuxProcessManager } from '../LinuxProcessManager';
import { mpstatBanner, sampleMpstat } from './Mpstat';

export interface IostatArgs {
  intervalSeconds: number | null;
  count: number | null;
  cpuOnly: boolean;
  deviceOnly: boolean;
  extended: boolean;
  megabytes: boolean;
  showTimestamp: boolean;
  omitFirst: boolean;
  omitIdle: boolean;
  perPartition: boolean;
}

export interface IostatCpuRow {
  user: number;
  nice: number;
  system: number;
  iowait: number;
  steal: number;
  idle: number;
}

export interface IostatDeviceRow {
  device: string;
  tps: number;
  readPerSec: number;
  writtenPerSec: number;
  discardedPerSec: number;
  readTotal: number;
  writtenTotal: number;
  discardedTotal: number;
  active: boolean;
}

const CPU_COLUMNS = ['%user', '%nice', '%system', '%iowait', '%steal', '%idle'] as const;

const DEVICE_TOTAL_COLUMNS = ['tps'] as const;

const EXTENDED_COLUMNS = [
  'r/s', 'rkB/s', 'rrqm/s', '%rrqm', 'r_await', 'rareq-sz',
  'w/s', 'wkB/s', 'wrqm/s', '%wrqm', 'w_await', 'wareq-sz',
  'd/s', 'dkB/s', 'drqm/s', '%drqm', 'd_await', 'dareq-sz',
  'f/s', 'f_await', 'aqu-sz', '%util',
] as const;

export function parseIostatArgs(args: string[]): IostatArgs | { error: string } {
  let intervalSeconds: number | null = null;
  let count: number | null = null;
  let cpuOnly = false;
  let deviceOnly = false;
  let extended = false;
  let megabytes = false;
  let showTimestamp = false;
  let omitFirst = false;
  let omitIdle = false;
  let perPartition = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-V' || a === '--version') {
      return { error: 'sysstat version 12.5.2' };
    }
    if (a === '-p') {
      perPartition = true;
      const next = args[i + 1];
      if (next && !next.startsWith('-') && !/^\d+$/.test(next)) i++;
      continue;
    }
    if (a.startsWith('--')) {
      return { error: `iostat: unrecognized option '${a}'` };
    }
    if (a.startsWith('-') && a.length > 1) {
      for (const flag of a.slice(1)) {
        switch (flag) {
          case 'c': cpuOnly = true; break;
          case 'd': deviceOnly = true; break;
          case 'x': extended = true; break;
          case 'k': megabytes = false; break;
          case 'm': megabytes = true; break;
          case 't': showTimestamp = true; break;
          case 'y': omitFirst = true; break;
          case 'z': omitIdle = true; break;
          case 'h': case 'N': case 'n': break;
          default: return { error: `iostat: invalid option -- '${flag}'` };
        }
      }
      continue;
    }
    positional.push(a);
  }

  const numeric = positional.filter((p) => /^\d+$/.test(p));
  if (numeric.length >= 1) intervalSeconds = parseInt(numeric[0], 10);
  if (numeric.length >= 2) count = parseInt(numeric[1], 10);

  return {
    intervalSeconds, count, cpuOnly, deviceOnly, extended, megabytes,
    showTimestamp, omitFirst, omitIdle, perPartition,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function iostatBanner(kernel: KernelInfo, hostname: string, cpu: CpuSpec, now: Date): string {
  return mpstatBanner(kernel, hostname, cpu, now);
}

export function iostatTimestamp(now: Date): string {
  const date = `${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}/${now.getFullYear()}`;
  const h = now.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${date} ${pad2(h12)}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())} ${ampm}`;
}

export function iostatCpuHeader(): string {
  return 'avg-cpu:' + CPU_COLUMNS.map((c) => c.padStart(8)).join('');
}

export function formatIostatCpuRow(row: IostatCpuRow): string {
  return ' '.repeat(8) + [row.user, row.nice, row.system, row.iowait, row.steal, row.idle]
    .map((v) => v.toFixed(2).padStart(8)).join('');
}

function defaultDeviceLabels(megabytes: boolean): string[] {
  const unit = megabytes ? 'MB' : 'kB';
  return [
    ...DEVICE_TOTAL_COLUMNS,
    `${unit}_read/s`, `${unit}_wrtn/s`, `${unit}_dscd/s`,
    `${unit}_read`, `${unit}_wrtn`, `${unit}_dscd`,
  ];
}

function extendedDeviceLabels(megabytes: boolean): string[] {
  if (!megabytes) return [...EXTENDED_COLUMNS];
  return EXTENDED_COLUMNS.map((c) => c === 'rkB/s' ? 'rMB/s' : c === 'wkB/s' ? 'wMB/s' : c === 'dkB/s' ? 'dMB/s' : c);
}

export function iostatDeviceHeader(args: IostatArgs): string {
  const labels = args.extended ? extendedDeviceLabels(args.megabytes) : defaultDeviceLabels(args.megabytes);
  return 'Device'.padEnd(13) + labels.map((l) => l.padStart(12)).join('');
}

export function formatIostatDeviceRow(args: IostatArgs, row: IostatDeviceRow): string {
  if (args.extended) {
    const zeros = new Array(EXTENDED_COLUMNS.length).fill(0).map((v) => v.toFixed(2).padStart(12)).join('');
    return row.device.padEnd(13) + zeros;
  }
  const rates = [row.tps, row.readPerSec, row.writtenPerSec, row.discardedPerSec]
    .map((v) => v.toFixed(2).padStart(12)).join('');
  const totals = [row.readTotal, row.writtenTotal, row.discardedTotal]
    .map((v) => String(v).padStart(12)).join('');
  return row.device.padEnd(13) + rates + totals;
}

export function sampleIostatCpu(pm: LinuxProcessManager, cpu: CpuSpec): IostatCpuRow {
  const aggregate = sampleMpstat(
    { intervalSeconds: null, count: null, showAllCpus: false, selectedCpus: null },
    pm, cpu,
  )[0];
  return {
    user: aggregate.usr,
    nice: aggregate.nice,
    system: aggregate.sys,
    iowait: aggregate.iowait,
    steal: aggregate.steal,
    idle: aggregate.idle,
  };
}

export function sampleIostatDevices(args: IostatArgs, storage: StorageDevice[]): IostatDeviceRow[] {
  const rows: IostatDeviceRow[] = [];
  for (const disk of storage) {
    rows.push(makeDeviceRow(disk.name));
    if (args.perPartition) {
      for (const part of disk.partitions) rows.push(makeDeviceRow(part.name));
    }
  }
  if (args.omitIdle) return rows.filter((r) => r.active);
  return rows;
}

function makeDeviceRow(device: string): IostatDeviceRow {
  return {
    device,
    tps: 0,
    readPerSec: 0,
    writtenPerSec: 0,
    discardedPerSec: 0,
    readTotal: 0,
    writtenTotal: 0,
    discardedTotal: 0,
    active: false,
  };
}

export function renderIostatReport(
  args: IostatArgs,
  cpu: IostatCpuRow,
  devices: IostatDeviceRow[],
  now: Date,
): string {
  const lines: string[] = [];
  if (args.showTimestamp) lines.push(iostatTimestamp(now));
  if (!args.deviceOnly) {
    lines.push(iostatCpuHeader());
    lines.push(formatIostatCpuRow(cpu));
    if (!args.cpuOnly) lines.push('');
  }
  if (!args.cpuOnly) {
    lines.push(iostatDeviceHeader(args));
    for (const row of devices) lines.push(formatIostatDeviceRow(args, row));
  }
  return lines.join('\n');
}

export interface IostatContext {
  pm: LinuxProcessManager;
  cpu: CpuSpec;
  storage: StorageDevice[];
  kernel: KernelInfo;
  hostname: string;
}

export function cmdIostat(args: string[], ctx: IostatContext): { output: string; exitCode: number } {
  const parsed = parseIostatArgs(args);
  if ('error' in parsed) {
    return { output: parsed.error, exitCode: parsed.error.startsWith('sysstat') ? 0 : 1 };
  }
  const now = new Date();
  const banner = iostatBanner(ctx.kernel, ctx.hostname, ctx.cpu, now);
  const cpuRow = sampleIostatCpu(ctx.pm, ctx.cpu);
  const devices = sampleIostatDevices(parsed, ctx.storage);
  const report = renderIostatReport(parsed, cpuRow, devices, now);
  return { output: `${banner}\n${report}`, exitCode: 0 };
}
