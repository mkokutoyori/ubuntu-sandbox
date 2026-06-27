import type { WindowsPC } from '../WindowsPC';

export interface GetCounterParsedArgs {
  counters: string[];
  sampleInterval: number;
  maxSamples: number;
  continuous: boolean;
  listSet: string | null;
  showHelp: boolean;
  parseError?: string;
}

export const DEFAULT_COUNTERS = [
  '\\Processor(_Total)\\% Processor Time',
  '\\Memory\\Available MBytes',
];

export const GET_COUNTER_HELP = `
NAME
    Get-Counter

SYNOPSIS
    Gets performance counter data from local or remote computers.

SYNTAX
    Get-Counter [[-Counter] <String[]>] [-SampleInterval <Int32>]
                [-MaxSamples <Int64>] [-Continuous] [<CommonParameters>]
    Get-Counter -ListSet <String[]> [<CommonParameters>]
`.trim();

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseStringList(raw: string): string[] {
  return raw.split(',').map((s) => unquote(s.trim())).filter(Boolean);
}

export function parseGetCounterArgs(args: string[]): GetCounterParsedArgs {
  const out: GetCounterParsedArgs = {
    counters: [],
    sampleInterval: 1,
    maxSamples: 1,
    continuous: false,
    listSet: null,
    showHelp: false,
  };
  const stack = [...args];
  while (stack.length > 0) {
    const a = stack.shift()!;
    const al = a.toLowerCase();
    if (al === '-?' || al === '/?' || al === '--help') { out.showHelp = true; continue; }
    if (al === '-continuous') { out.continuous = true; continue; }
    if (al === '-counter') {
      const v = stack.shift();
      if (!v) { out.parseError = 'Get-Counter: -Counter requires a value'; return out; }
      out.counters.push(...parseStringList(unquote(v)));
      continue;
    }
    if (al === '-sampleinterval') {
      const v = parseInt(stack.shift() ?? '', 10);
      if (!Number.isFinite(v) || v <= 0) { out.parseError = 'Get-Counter: -SampleInterval must be a positive integer'; return out; }
      out.sampleInterval = v;
      continue;
    }
    if (al === '-maxsamples') {
      const v = parseInt(stack.shift() ?? '', 10);
      if (!Number.isFinite(v) || v <= 0) { out.parseError = 'Get-Counter: -MaxSamples must be a positive integer'; return out; }
      out.maxSamples = v;
      continue;
    }
    if (al === '-listset') {
      const v = stack.shift();
      if (!v) { out.parseError = 'Get-Counter: -ListSet requires a value'; return out; }
      out.listSet = unquote(v);
      continue;
    }
    if (a.startsWith('-')) { out.parseError = `Get-Counter: unrecognized parameter ${a}`; return out; }
    // Positional → first arg is -Counter list.
    if (out.counters.length === 0) out.counters.push(...parseStringList(unquote(a)));
  }
  if (out.counters.length === 0 && !out.listSet && !out.showHelp) {
    out.counters = [...DEFAULT_COUNTERS];
  }
  return out;
}

export interface CounterSample {
  /** Canonical lower-case path like the real Get-Counter renders. */
  path: string;
  value: number;
  /** True when the path was not recognised — value will be 0. */
  unknown: boolean;
}

export interface CounterSnapshot {
  ts: Date;
  samples: CounterSample[];
}

/** Per-port {framesIn,bytesIn,…} cumulative snapshot for delta computations. */
export interface PortCountersSnapshot {
  framesIn: number;
  framesOut: number;
  bytesIn: number;
  bytesOut: number;
}

export interface CounterRateState {
  /** ts (ms) of the previous sample by port name */
  lastTsMs: Map<string, number>;
  /** previous cumulative counters by port name */
  prev: Map<string, PortCountersSnapshot>;
}

export function newRateState(): CounterRateState {
  return { lastTsMs: new Map(), prev: new Map() };
}

const COUNTER_SET_REGISTRY: Record<string, string[]> = {
  processor: ['\\Processor(_Total)\\% Processor Time'],
  memory: [
    '\\Memory\\Available MBytes',
    '\\Memory\\% Committed Bytes In Use',
  ],
  system: ['\\System\\Processes', '\\System\\Threads'],
  'network interface': ['\\Network Interface(*)\\Bytes Total/sec'],
};

/**
 * Render a counter set listing — what `Get-Counter -ListSet <name>` returns.
 * Unknown sets produce a PS-style error line.
 */
export function formatCounterSet(name: string): string {
  const lower = name.toLowerCase();
  const paths = COUNTER_SET_REGISTRY[lower];
  if (!paths) {
    return `Get-Counter: Counter set was not found: ${name}`;
  }
  const lines: string[] = [];
  lines.push(`CounterSetName     : ${name}`);
  lines.push('MachineName        : .');
  lines.push('CounterSetType     : SingleInstance');
  lines.push('Description        :');
  lines.push('Paths              : {' + paths.join(', ') + '}');
  lines.push('PathsWithInstances : {' + paths.join(', ') + '}');
  return lines.join('\n');
}

function fmtTs(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    (d.getHours() < 12 ? 'AM' : 'PM');
}

/**
 * Format a CounterSnapshot exactly like PowerShell's
 *   Timestamp                 CounterSamples
 *   ---------                 --------------
 *   <ts>                      \\host\path :
 *                                   <value>
 */
export function formatCounterSnapshot(hostname: string, snap: CounterSnapshot): string {
  const lines: string[] = [];
  lines.push('Timestamp                 CounterSamples');
  lines.push('---------                 --------------');
  let first = true;
  for (const s of snap.samples) {
    const prefix = first ? fmtTs(snap.ts).padEnd(26) : ' '.repeat(26);
    lines.push(`${prefix}\\\\${hostname.toLowerCase()}${s.path.toLowerCase()} :`);
    lines.push(`${' '.repeat(26)}      ${s.value.toFixed(s.unknown ? 0 : 2)}`);
    first = false;
    lines.push('');
  }
  // strip the trailing blank line
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function expandWildcardCounters(path: string, dev: WindowsPC): string[] {
  if (path.includes('(*)')) {
    const ports = dev.getPortNames();
    return ports.map((p) => path.replace('(*)', `(${p.toLowerCase()})`));
  }
  return [path];
}

/**
 * Sample one counter path against the device's live state.
 * Unknown paths produce { unknown:true, value:0 }.
 */
export function sampleCounter(
  path: string,
  dev: WindowsPC,
  rateState: CounterRateState,
): CounterSample {
  const lower = path.toLowerCase();
  const now = Date.now();

  if (lower === '\\processor(_total)\\% processor time') {
    const procs = dev.getProcessManager().getAllProcesses();
    // Same heuristic as Linux vmstat: each runnable process pushes ~10%.
    const load = Math.min(100, procs.length * 1.2);
    return { path, value: load, unknown: false };
  }
  if (lower === '\\memory\\available mbytes') {
    const mem = dev.getHardware().memory;
    return { path, value: Math.round(mem.freeKib / 1024), unknown: false };
  }
  if (lower === '\\memory\\% committed bytes in use') {
    const mem = dev.getHardware().memory;
    const used = mem.totalKib - mem.freeKib;
    return { path, value: (used / mem.totalKib) * 100, unknown: false };
  }
  if (lower === '\\system\\processes') {
    return { path, value: dev.getProcessManager().getAllProcesses().length, unknown: false };
  }
  if (lower === '\\system\\threads') {
    return { path, value: dev.getProcessManager().getAllProcesses().length * 4, unknown: false };
  }
  const ifaceMatch = lower.match(/^\\network interface\((.+)\)\\bytes total\/sec$/);
  if (ifaceMatch) {
    const portName = ifaceMatch[1];
    const port = dev.getPorts().find((p) => p.getName().toLowerCase() === portName);
    if (!port) return { path, value: 0, unknown: true };
    const c = port.getCounters();
    const snap: PortCountersSnapshot = {
      framesIn: c.framesIn, framesOut: c.framesOut,
      bytesIn: c.bytesIn, bytesOut: c.bytesOut,
    };
    const prevTs = rateState.lastTsMs.get(portName);
    const prev = rateState.prev.get(portName);
    rateState.lastTsMs.set(portName, now);
    rateState.prev.set(portName, snap);
    if (!prev || prevTs === undefined) return { path, value: 0, unknown: false };
    const deltaSec = Math.max(0.001, (now - prevTs) / 1000);
    const deltaBytes = (snap.bytesIn + snap.bytesOut) - (prev.bytesIn + prev.bytesOut);
    return { path, value: Math.max(0, deltaBytes / deltaSec), unknown: false };
  }
  return { path, value: 0, unknown: true };
}

export function sampleCounterSet(
  requested: string[],
  dev: WindowsPC,
  rateState: CounterRateState,
): CounterSnapshot {
  const expanded: string[] = [];
  for (const c of requested) expanded.push(...expandWildcardCounters(c, dev));
  const samples = expanded.map((p) => sampleCounter(p, dev, rateState));
  return { ts: new Date(), samples };
}
