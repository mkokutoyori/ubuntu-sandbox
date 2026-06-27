import type { MemoryProfile } from '../../host/hardware/MemoryProfile';
import type { LinuxProcessManager } from '../LinuxProcessManager';

export interface DstatGroups {
  time: boolean;
  cpu: boolean;
  disk: boolean;
  memory: boolean;
  net: boolean;
  paging: boolean;
  system: boolean;
}

export const DEFAULT_GROUPS: DstatGroups = {
  time: true, cpu: true, disk: true, memory: false,
  net: true, paging: true, system: true,
};

export interface DstatArgs {
  groups: DstatGroups;
  intervalSeconds: number;
  count: number | null;
  ifaceFilter: string | null;
  diskFilter: string | null;
  showVersion: boolean;
  showHelp: boolean;
  listStats: boolean;
  parseError?: string;
}

export const DSTAT_VERSION = 'pcp-dstat 6.0.0';
export const DSTAT_USAGE = `Usage: dstat [-afv] [options..] [delay [count]]
Versatile tool for generating system resource statistics

  -c, --cpu            enable cpu stats
  -d, --disk           enable disk stats
  -m, --mem            enable memory stats
  -n, --net            enable network stats
  -s, --swap           enable swap (paging) stats
  -t, --time           enable timestamp
  -D <device>          select disk(s)
  -N <interface>       select interface(s)
      --list           list available stats
  -V, --version        show version
  -h, --help           show this help`;

export const DSTAT_LISTING = [
  'internal:',
  '   cpu, disk, mem, net, paging, system, time',
].join('\n');

function setOnly(g: Partial<DstatGroups>): DstatGroups {
  return {
    time: g.time ?? false, cpu: g.cpu ?? false, disk: g.disk ?? false,
    memory: g.memory ?? false, net: g.net ?? false, paging: g.paging ?? false,
    system: g.system ?? false,
  };
}

export function parseDstatArgs(args: string[]): DstatArgs {
  const out: DstatArgs = {
    groups: { ...DEFAULT_GROUPS },
    intervalSeconds: 1,
    count: null,
    ifaceFilter: null,
    diskFilter: null,
    showVersion: false,
    showHelp: false,
    listStats: false,
  };

  const explicit: Partial<DstatGroups> = {};
  const stack = [...args];
  let positional = 0;
  while (stack.length > 0) {
    const a = stack.shift()!;
    // Long options are case-insensitive, short flags are case-sensitive
    // (real dstat: -n ⇒ net group, -N ⇒ interface filter).
    if (a === '--version' || a === '-v') { out.showVersion = true; continue; }
    if (a === '--help' || a === '-h') { out.showHelp = true; continue; }
    if (a === '--list') { out.listStats = true; continue; }
    if (a === '-c' || a === '--cpu') { explicit.cpu = true; continue; }
    if (a === '-d' || a === '--disk') { explicit.disk = true; continue; }
    if (a === '-m' || a === '--mem') { explicit.memory = true; continue; }
    if (a === '-n' || a === '--net') { explicit.net = true; continue; }
    if (a === '-s' || a === '--swap') { explicit.paging = true; continue; }
    if (a === '-t' || a === '--time') { explicit.time = true; continue; }
    if (a === '-y' || a === '--sys') { explicit.system = true; continue; }
    if (a === '-a') { /* -a = -cdngy default; alias of default */ continue; }
    if (a === '-N') {
      const v = stack.shift();
      if (!v) { out.parseError = 'dstat: -N requires an interface'; return out; }
      out.ifaceFilter = v;
      continue;
    }
    if (a === '-D') {
      const v = stack.shift();
      if (!v) { out.parseError = 'dstat: -D requires a disk'; return out; }
      out.diskFilter = v;
      continue;
    }
    if (a.startsWith('-')) { out.parseError = `dstat: unknown option ${a}`; return out; }
    // Positional: first is delay (interval), second is count.
    const n = parseInt(a, 10);
    if (Number.isFinite(n) && n > 0) {
      if (positional === 0) out.intervalSeconds = n;
      else if (positional === 1) out.count = n;
      positional++;
      continue;
    }
    out.parseError = `dstat: cannot parse ${a}`;
    return out;
  }

  if (Object.keys(explicit).length > 0) {
    out.groups = setOnly({ ...explicit, time: explicit.time ?? out.groups.time });
  }
  return out;
}

export interface DstatSample {
  ts: Date;
  cpu: { user: number; system: number; idle: number; wait: number; steal: number };
  disk: { readBytesPerSec: number; writeBytesPerSec: number };
  memory: { usedKib: number; buffersKib: number; cacheKib: number; freeKib: number };
  net: { recvBytesPerSec: number; sendBytesPerSec: number };
  paging: { inKib: number; outKib: number };
  system: { interruptsPerSec: number; ctxSwitchesPerSec: number };
}

export interface PortByteSnapshot {
  bytesIn: number;
  bytesOut: number;
}

export interface DstatRateState {
  lastTsMs: number | null;
  prevTotalBytesIn: number;
  prevTotalBytesOut: number;
}

export function newDstatRateState(): DstatRateState {
  return { lastTsMs: null, prevTotalBytesIn: 0, prevTotalBytesOut: 0 };
}

export interface DstatSampleContext {
  pm: LinuxProcessManager;
  memory: MemoryProfile;
  ports: PortByteSnapshot[];
}

export function sampleDstat(ctx: DstatSampleContext, rate: DstatRateState): DstatSample {
  const procs = ctx.pm.list();
  const procsR = procs.filter((p) => p.state === 'R').length;
  const cpuLoad = Math.min(100, procsR * 100);
  const user = Math.round(cpuLoad * 0.6);
  const system = Math.round(cpuLoad * 0.4);
  const idle = Math.max(0, 100 - user - system);

  const totalIn = ctx.ports.reduce((a, p) => a + p.bytesIn, 0);
  const totalOut = ctx.ports.reduce((a, p) => a + p.bytesOut, 0);
  const now = Date.now();
  let recvPerSec = 0;
  let sendPerSec = 0;
  if (rate.lastTsMs !== null) {
    const deltaSec = Math.max(0.001, (now - rate.lastTsMs) / 1000);
    recvPerSec = Math.max(0, (totalIn - rate.prevTotalBytesIn) / deltaSec);
    sendPerSec = Math.max(0, (totalOut - rate.prevTotalBytesOut) / deltaSec);
  }
  rate.lastTsMs = now;
  rate.prevTotalBytesIn = totalIn;
  rate.prevTotalBytesOut = totalOut;

  return {
    ts: new Date(now),
    cpu: { user, system, idle, wait: 0, steal: 0 },
    disk: { readBytesPerSec: 0, writeBytesPerSec: 0 },
    memory: {
      usedKib: Math.max(0, ctx.memory.totalKib - ctx.memory.freeKib - ctx.memory.buffersKib - ctx.memory.cacheKib),
      buffersKib: ctx.memory.buffersKib,
      cacheKib: ctx.memory.cacheKib,
      freeKib: ctx.memory.freeKib,
    },
    net: { recvBytesPerSec: recvPerSec, sendBytesPerSec: sendPerSec },
    paging: { inKib: 0, outKib: 0 },
    system: { interruptsPerSec: 0, ctxSwitchesPerSec: 0 },
  };
}

/** Render bytes/sec compactly à la dstat: 1024 → "1024B", 1500 → "1500B", 10240 → " 10k", … */
function compact(n: number): string {
  if (n < 1000) return `${Math.round(n)}B`.padStart(4);
  if (n < 1_000_000) return `${(n / 1000).toFixed(0)}k`.padStart(4);
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(0)}M`.padStart(4);
  return `${(n / 1_000_000_000).toFixed(0)}G`.padStart(4);
}

function fmtCpuPct(n: number): string {
  return String(Math.round(n)).padStart(3);
}

function fmtTs(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface GroupColumns { title: string; columns: string }

function groupCols(g: DstatGroups): GroupColumns[] {
  const out: GroupColumns[] = [];
  if (g.time) out.push({ title: '----system----', columns: '     time     ' });
  if (g.cpu)  out.push({ title: '----total-cpu-usage----', columns: 'usr sys idl wai stl' });
  if (g.disk) out.push({ title: '-dsk/total-', columns: ' read  writ' });
  if (g.memory) out.push({ title: '------memory-usage-----', columns: ' used  buff  cach  free' });
  if (g.net)  out.push({ title: '-net/total-', columns: ' recv  send' });
  if (g.paging) out.push({ title: '---paging--', columns: '  in   out' });
  if (g.system) out.push({ title: '---system--', columns: ' int   csw' });
  return out;
}

export function formatDstatHeader(g: DstatGroups): string {
  const cols = groupCols(g);
  return cols.map((c) => c.title).join(' ') + '\n' + cols.map((c) => c.columns).join(' ');
}

export function formatDstatRow(sample: DstatSample, g: DstatGroups): string {
  const parts: string[] = [];
  if (g.time) parts.push(fmtTs(sample.ts).padStart(14));
  if (g.cpu) parts.push(
    `${fmtCpuPct(sample.cpu.user)} ${fmtCpuPct(sample.cpu.system)} ${fmtCpuPct(sample.cpu.idle)} ` +
    `${fmtCpuPct(sample.cpu.wait)} ${fmtCpuPct(sample.cpu.steal)}`,
  );
  if (g.disk) parts.push(`${compact(sample.disk.readBytesPerSec)} ${compact(sample.disk.writeBytesPerSec)}`);
  if (g.memory) parts.push(
    `${compact(sample.memory.usedKib * 1024)} ${compact(sample.memory.buffersKib * 1024)} ` +
    `${compact(sample.memory.cacheKib * 1024)} ${compact(sample.memory.freeKib * 1024)}`,
  );
  if (g.net) parts.push(`${compact(sample.net.recvBytesPerSec)} ${compact(sample.net.sendBytesPerSec)}`);
  if (g.paging) parts.push(`${compact(sample.paging.inKib * 1024)} ${compact(sample.paging.outKib * 1024)}`);
  if (g.system) parts.push(
    `${String(sample.system.interruptsPerSec).padStart(4)} ${String(sample.system.ctxSwitchesPerSec).padStart(5)}`,
  );
  return parts.join(' ');
}
