import type { MemoryProfile } from '../../host/hardware';
import type { LinuxProcessManager } from '../LinuxProcessManager';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

export interface VmstatArgs {
  intervalSeconds: number | null;
  count: number | null;
  unit: 'k' | 'K' | 'm' | 'M';
  wide: boolean;
  noRecurringHeader: boolean;
  timestamp: boolean;
}

export interface VmstatSample {
  procsR: number;
  procsB: number;
  swpdKib: number;
  freeKib: number;
  buffKib: number;
  cacheKib: number;
  siKibPerSec: number;
  soKibPerSec: number;
  biBlocksPerSec: number;
  boBlocksPerSec: number;
  interruptsPerSec: number;
  ctxSwitchesPerSec: number;
  cpuUser: number;
  cpuSystem: number;
  cpuIdle: number;
  cpuIowait: number;
  cpuSteal: number;
}

export function parseVmstatArgs(args: string[]): VmstatArgs | { error: string } {
  let intervalSeconds: number | null = null;
  let count: number | null = null;
  let unit: 'k' | 'K' | 'm' | 'M' = 'k';
  let wide = false;
  let noRecurringHeader = false;
  let timestamp = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-w' || a === '--wide') wide = true;
    else if (a === '-n' || a === '--one-header') noRecurringHeader = true;
    else if (a === '-t' || a === '--timestamp') timestamp = true;
    else if (a === '-S' || a === '--unit') {
      const v = args[++i] ?? '';
      if (v !== 'k' && v !== 'K' && v !== 'm' && v !== 'M') return { error: `vmstat: -S requires k, K, m, or M` };
      unit = v;
    } else if (a === '-a' || a === '-d' || a === '-D' || a === '-f' || a === '-m' || a === '-s' || a === '-V') {
      // accepted but not implemented in this snapshot mode
    } else if (a.startsWith('-')) {
      return { error: `vmstat: unrecognized option: ${a}` };
    } else if (/^\d+$/.test(a)) {
      positional.push(a);
    } else {
      return { error: `vmstat: bad argument: ${a}` };
    }
  }

  if (positional.length >= 1) intervalSeconds = parseInt(positional[0], 10);
  if (positional.length >= 2) count = parseInt(positional[1], 10);
  if (positional.length > 2) return { error: 'vmstat: too many arguments' };

  return { intervalSeconds, count, unit, wide, noRecurringHeader, timestamp };
}

const TIMESTAMP_HEADER = ' -----timestamp-----';

export function vmstatHeader(args: VmstatArgs, zoneName = ''): string {
  const stamped = (title: string, columns: string): string[] => (args.timestamp
    ? [title + TIMESTAMP_HEADER, `${columns} ${zoneName.padStart(TIMESTAMP_HEADER.length - 1)}`]
    : [title, columns]);
  if (args.wide) {
    return stamped(
      '--procs-- -----------------------memory---------------------- ---swap-- -----io---- -system-- --------cpu--------',
      '   r    b         swpd         free         buff        cache   si   so    bi    bo   in   cs  us  sy  id  wa  st',
    ).join('\n');
  }
  return stamped(
    'procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----',
    ' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st',
  ).join('\n');
}

function scaleMemory(kib: number, unit: VmstatArgs['unit']): number {
  switch (unit) {
    case 'k': return kib;
    case 'K': return Math.round(kib * 1024 / 1000);
    case 'm': return Math.round(kib / 1024);
    case 'M': return Math.round(kib / 1000);
  }
}

export function formatVmstatRow(sample: VmstatSample, args: VmstatArgs, stamp = ''): string {
  const row = formatVmstatColumns(sample, args);
  return args.timestamp ? `${row} ${stamp}` : row;
}

function formatVmstatColumns(sample: VmstatSample, args: VmstatArgs): string {
  const m = (kib: number) => scaleMemory(kib, args.unit);
  if (args.wide) {
    return [
      padToWidth(String(sample.procsR), 4, 'right'),
      padToWidth(String(sample.procsB), 4, 'right'),
      padToWidth(String(m(sample.swpdKib)), 12, 'right'),
      padToWidth(String(m(sample.freeKib)), 12, 'right'),
      padToWidth(String(m(sample.buffKib)), 12, 'right'),
      padToWidth(String(m(sample.cacheKib)), 12, 'right'),
      padToWidth(String(sample.siKibPerSec), 4, 'right'),
      padToWidth(String(sample.soKibPerSec), 4, 'right'),
      padToWidth(String(sample.biBlocksPerSec), 5, 'right'),
      padToWidth(String(sample.boBlocksPerSec), 5, 'right'),
      padToWidth(String(sample.interruptsPerSec), 4, 'right'),
      padToWidth(String(sample.ctxSwitchesPerSec), 4, 'right'),
      padToWidth(String(sample.cpuUser), 3, 'right'),
      padToWidth(String(sample.cpuSystem), 3, 'right'),
      padToWidth(String(sample.cpuIdle), 3, 'right'),
      padToWidth(String(sample.cpuIowait), 3, 'right'),
      padToWidth(String(sample.cpuSteal), 3, 'right'),
    ].join(' ');
  }
  return [
    padToWidth(String(sample.procsR), 2, 'right'),
    padToWidth(String(sample.procsB), 2, 'right'),
    padToWidth(String(m(sample.swpdKib)), 6, 'right'),
    padToWidth(String(m(sample.freeKib)), 6, 'right'),
    padToWidth(String(m(sample.buffKib)), 6, 'right'),
    padToWidth(String(m(sample.cacheKib)), 6, 'right'),
    padToWidth(String(sample.siKibPerSec), 4, 'right'),
    padToWidth(String(sample.soKibPerSec), 4, 'right'),
    padToWidth(String(sample.biBlocksPerSec), 5, 'right'),
    padToWidth(String(sample.boBlocksPerSec), 5, 'right'),
    padToWidth(String(sample.interruptsPerSec), 4, 'right'),
    padToWidth(String(sample.ctxSwitchesPerSec), 4, 'right'),
    padToWidth(String(sample.cpuUser), 2, 'right'),
    padToWidth(String(sample.cpuSystem), 2, 'right'),
    padToWidth(String(sample.cpuIdle), 2, 'right'),
    padToWidth(String(sample.cpuIowait), 2, 'right'),
    padToWidth(String(sample.cpuSteal), 2, 'right'),
  ].join(' ');
}

export function sampleVmstat(pm: LinuxProcessManager, memory: MemoryProfile): VmstatSample {
  const procs = pm.list();
  const procsR = procs.filter((p) => p.state === 'R').length;
  const procsB = procs.filter((p) => p.state === 'D').length;
  const cpuLoad = Math.min(100, procsR * 100);
  const cpuUser = Math.round(cpuLoad * 0.6);
  const cpuSystem = Math.round(cpuLoad * 0.4);
  const cpuIdle = Math.max(0, 100 - cpuUser - cpuSystem);
  return {
    procsR,
    procsB,
    swpdKib: memory.swapUsedKib,
    freeKib: memory.freeKib,
    buffKib: memory.buffersKib,
    cacheKib: memory.cacheKib,
    siKibPerSec: 0,
    soKibPerSec: 0,
    biBlocksPerSec: 0,
    boBlocksPerSec: 0,
    interruptsPerSec: 0,
    ctxSwitchesPerSec: 0,
    cpuUser,
    cpuSystem,
    cpuIdle,
    cpuIowait: 0,
    cpuSteal: 0,
  };
}

export interface VmstatContext {
  pm: LinuxProcessManager;
  memory: MemoryProfile;
  formatTime: (format: string) => string;
}

export function cmdVmstat(args: string[], ctx: VmstatContext): { output: string; exitCode: number } {
  const parsed = parseVmstatArgs(args);
  if ('error' in parsed) return { output: parsed.error, exitCode: 1 };
  const lines: string[] = [vmstatHeader(parsed, parsed.timestamp ? ctx.formatTime('%Z') : '')];
  const sample = sampleVmstat(ctx.pm, ctx.memory);
  lines.push(formatVmstatRow(sample, parsed, parsed.timestamp ? ctx.formatTime('%Y-%m-%d %H:%M:%S') : ''));
  return { output: lines.join('\n'), exitCode: 0 };
}
