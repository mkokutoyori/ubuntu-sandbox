export interface MtrParsedArgs {
  target: string;
  reportMode: boolean;
  cycles: number;
  intervalSec: number;
  noDns: boolean;
  maxHops: number;
  showHelp: boolean;
  showVersion: boolean;
  parseError?: string;
}

export const MTR_USAGE = `usage: mtr [-rwxFnoiBgcfqsmStTUI4*6*][-PORT][--displaymode N][--help] HOSTNAME

  -r --report                  report mode: print after N cycles, then exit
  -c COUNT --report-cycles=COUNT  set report-mode cycle count (default 10)
  -i SECONDS --interval=SECONDS   time between cycles (default 1)
  -m HOPS --max-ttl=HOPS       set max number of hops (default 30)
  -n --no-dns                  do not resolve hostnames
  -V --version                 print version and exit
  --help                       print this help and exit`;

export const MTR_VERSION = 'mtr 0.95';

export function parseMtrArgs(args: string[]): MtrParsedArgs {
  const out: MtrParsedArgs = {
    target: '',
    reportMode: false,
    cycles: 10,
    intervalSec: 1,
    noDns: false,
    maxHops: 30,
    showHelp: false,
    showVersion: false,
  };

  const stack = [...args];
  while (stack.length > 0) {
    const a = stack.shift()!;
    if (a === '--help') { out.showHelp = true; continue; }
    if (a === '-V' || a === '--version') { out.showVersion = true; continue; }
    if (a === '-r' || a === '--report') { out.reportMode = true; continue; }
    if (a === '-n' || a === '--no-dns') { out.noDns = true; continue; }
    if (a === '-c' || a === '--report-cycles') {
      const v = parseInt(stack.shift() ?? '', 10);
      if (!Number.isFinite(v) || v <= 0) { out.parseError = `mtr: bad cycles ${a}`; return out; }
      out.cycles = v; continue;
    }
    if (a.startsWith('--report-cycles=')) {
      const v = parseInt(a.slice('--report-cycles='.length), 10);
      if (!Number.isFinite(v) || v <= 0) { out.parseError = `mtr: bad cycles ${a}`; return out; }
      out.cycles = v; continue;
    }
    if (a === '-i' || a === '--interval') {
      const v = parseFloat(stack.shift() ?? '');
      if (!Number.isFinite(v) || v <= 0) { out.parseError = `mtr: bad interval ${a}`; return out; }
      out.intervalSec = v; continue;
    }
    if (a.startsWith('--interval=')) {
      const v = parseFloat(a.slice('--interval='.length));
      if (!Number.isFinite(v) || v <= 0) { out.parseError = `mtr: bad interval ${a}`; return out; }
      out.intervalSec = v; continue;
    }
    if (a === '-m' || a === '--max-ttl') {
      const v = parseInt(stack.shift() ?? '', 10);
      if (!Number.isFinite(v) || v < 1 || v > 255) { out.parseError = `mtr: bad max-ttl ${a}`; return out; }
      out.maxHops = v; continue;
    }
    if (a.startsWith('--max-ttl=')) {
      const v = parseInt(a.slice('--max-ttl='.length), 10);
      if (!Number.isFinite(v) || v < 1 || v > 255) { out.parseError = `mtr: bad max-ttl ${a}`; return out; }
      out.maxHops = v; continue;
    }
    if (a.startsWith('-')) { out.parseError = `mtr: unrecognized option '${a}'`; return out; }
    if (!out.target) out.target = a;
  }
  return out;
}

export interface MtrHopProbe { ip?: string; rttMs?: number; lost: boolean }

export class MtrHopStats {
  ip: string | null = null;
  sent = 0;
  received = 0;
  last: number | null = null;
  best: number | null = null;
  worst: number | null = null;
  private sumRtt = 0;
  private sumSqRtt = 0;

  record(probe: MtrHopProbe): void {
    this.sent++;
    if (probe.ip) this.ip = probe.ip;
    if (probe.lost || probe.rttMs === undefined) return;
    this.received++;
    this.last = probe.rttMs;
    this.sumRtt += probe.rttMs;
    this.sumSqRtt += probe.rttMs * probe.rttMs;
    if (this.best === null || probe.rttMs < this.best) this.best = probe.rttMs;
    if (this.worst === null || probe.rttMs > this.worst) this.worst = probe.rttMs;
  }

  lossPct(): number {
    if (this.sent === 0) return 0;
    return (1 - this.received / this.sent) * 100;
  }

  avg(): number | null {
    return this.received === 0 ? null : this.sumRtt / this.received;
  }

  stDev(): number {
    if (this.received < 2) return 0;
    const mean = this.sumRtt / this.received;
    const variance = (this.sumSqRtt / this.received) - mean * mean;
    return variance > 0 ? Math.sqrt(variance) : 0;
  }
}

export interface MtrFrameInput {
  hostname: string;
  target: string;
  startedAt: Date;
  hops: MtrHopStats[];
}

function fmt(value: number | null, width: number, decimals = 1): string {
  if (value === null) return '?'.padStart(width);
  return value.toFixed(decimals).padStart(width);
}

function fmtInt(value: number, width: number): string {
  return String(value).padStart(width);
}

function fmtPct(value: number): string {
  return `${value.toFixed(1).padStart(5)}%`;
}

export function formatMtrFrame(input: MtrFrameInput, mode: 'live' | 'report' = 'live'): string {
  const { hostname, target, startedAt, hops } = input;
  const header = mode === 'report'
    ? `Start: ${startedAt.toISOString()}`
    : `${MTR_VERSION}                                       ${startedAt.toISOString()}`;
  const title = `${hostname} (${target})`;
  const lines: string[] = [];
  lines.push(header);
  lines.push(title);
  if (mode === 'live') lines.push('Keys:  Help   Display mode   Restart statistics   Order of fields   quit');
  lines.push('                                       Packets               Pings');
  lines.push(' Host                                Loss%   Snt   Last   Avg  Best  Wrst StDev');
  hops.forEach((h, idx) => {
    const num = String(idx + 1).padStart(2);
    const host = (h.ip ?? '???').padEnd(28);
    lines.push(
      ` ${num}. ${host} ${fmtPct(h.lossPct())} ${fmtInt(h.sent, 5)} ` +
      `${fmt(h.last, 6)} ${fmt(h.avg(), 5)} ${fmt(h.best, 5)} ${fmt(h.worst, 5)} ${fmt(h.stDev(), 5)}`,
    );
  });
  return lines.join('\n');
}
