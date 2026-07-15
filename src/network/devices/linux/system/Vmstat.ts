export interface VmstatArgs {
  intervalSeconds: number | null;
  count: number | null;
  unit: 'k' | 'K' | 'm' | 'M';
  wide: boolean;
  noRecurringHeader: boolean;
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
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-w' || a === '--wide') wide = true;
    else if (a === '-n' || a === '--one-header') noRecurringHeader = true;
    else if (a === '-S' || a === '--unit') {
      const v = args[++i] ?? '';
      if (v !== 'k' && v !== 'K' && v !== 'm' && v !== 'M') return { error: `vmstat: -S requires k, K, m, or M` };
      unit = v;
    } else if (a === '-a' || a === '-d' || a === '-D' || a === '-f' || a === '-m' || a === '-s' || a === '-t' || a === '-V') {
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

  return { intervalSeconds, count, unit, wide, noRecurringHeader };
}

export function vmstatHeader(args: VmstatArgs): string {
  if (args.wide) {
    return [
      '--procs-- -----------------------memory---------------------- ---swap-- -----io---- -system-- --------cpu--------',
      '   r    b         swpd         free         buff        cache   si   so    bi    bo   in   cs  us  sy  id  wa  st',
    ].join('\n');
  }
  return [
    'procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----',
    ' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st',
  ].join('\n');
}

function scaleMemory(kib: number, unit: VmstatArgs['unit']): number {
  switch (unit) {
    case 'k': return kib;
    case 'K': return Math.round(kib * 1024 / 1000);
    case 'm': return Math.round(kib / 1024);
    case 'M': return Math.round(kib / 1000);
  }
}

export function formatVmstatRow(sample: VmstatSample, args: VmstatArgs): string {
  const m = (kib: number) => scaleMemory(kib, args.unit);
  if (args.wide) {
    return [
      String(sample.procsR).padStart(4),
      String(sample.procsB).padStart(4),
      String(m(sample.swpdKib)).padStart(12),
      String(m(sample.freeKib)).padStart(12),
      String(m(sample.buffKib)).padStart(12),
      String(m(sample.cacheKib)).padStart(12),
      String(sample.siKibPerSec).padStart(4),
      String(sample.soKibPerSec).padStart(4),
      String(sample.biBlocksPerSec).padStart(5),
      String(sample.boBlocksPerSec).padStart(5),
      String(sample.interruptsPerSec).padStart(4),
      String(sample.ctxSwitchesPerSec).padStart(4),
      String(sample.cpuUser).padStart(3),
      String(sample.cpuSystem).padStart(3),
      String(sample.cpuIdle).padStart(3),
      String(sample.cpuIowait).padStart(3),
      String(sample.cpuSteal).padStart(3),
    ].join(' ');
  }
  return [
    String(sample.procsR).padStart(2),
    String(sample.procsB).padStart(2),
    String(m(sample.swpdKib)).padStart(6),
    String(m(sample.freeKib)).padStart(6),
    String(m(sample.buffKib)).padStart(6),
    String(m(sample.cacheKib)).padStart(6),
    String(sample.siKibPerSec).padStart(4),
    String(sample.soKibPerSec).padStart(4),
    String(sample.biBlocksPerSec).padStart(5),
    String(sample.boBlocksPerSec).padStart(5),
    String(sample.interruptsPerSec).padStart(4),
    String(sample.ctxSwitchesPerSec).padStart(4),
    String(sample.cpuUser).padStart(2),
    String(sample.cpuSystem).padStart(2),
    String(sample.cpuIdle).padStart(2),
    String(sample.cpuIowait).padStart(2),
    String(sample.cpuSteal).padStart(2),
  ].join(' ');
}

