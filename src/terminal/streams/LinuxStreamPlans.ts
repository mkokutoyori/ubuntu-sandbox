import { simulationDate, simulationNowMs } from '@/network/core/SystemClock';
import { IPAddress } from '@/network/core/types';
import { LinuxMachine } from '@/network/devices/LinuxMachine';
import type { LinuxShellSession } from '@/network/devices/linux/shell/LinuxShellSession';
import { createPing, type PingRun } from '@/network/devices/linux/commands/net/Ping';
import { runTraceroute } from '@/network/devices/linux/commands/net/Traceroute';
import { parseMtrArgs, MtrHopStats, formatMtrFrame, MTR_USAGE, MTR_VERSION, type MtrHopProbe } from '@/network/devices/linux/Mtr';
import { parseWatchArgs } from '@/network/devices/linux/coreutils/WatchRunner';
import { parseIpMonitorSpec } from '@/network/devices/linux/LinuxIpCommand';
import { parseVmstatArgs, vmstatHeader, formatVmstatRow } from '@/network/devices/linux/system/Vmstat';
import {
  parseMpstatArgs, mpstatColumnHeader, formatMpstatRow, formatMpstatAverageRow, MpstatAccumulator,
} from '@/network/devices/linux/system/Mpstat';
import {
  parsePidstatArgs, pidstatColumnHeader, formatPidstatCpuRow, formatPidstatMemRow, formatPidstatAverageCpuRow,
  formatPidstatAverageMemRow, PidstatAccumulator, type PidstatCpuRow, type PidstatMemRow,
} from '@/network/devices/linux/system/Pidstat';
import { parseIostatArgs, renderIostatReport } from '@/network/devices/linux/system/Iostat';
import {
  parseDstatArgs, formatDstatHeader, formatDstatRow, newDstatRateState, DSTAT_USAGE, DSTAT_VERSION, DSTAT_LISTING,
} from '@/network/devices/linux/system/Dstat';
import { interleaveTcpdumpStreams, runTcpdump } from '@/network/devices/linux/network/tcpdump/TcpdumpRunner';
import { followArguments, snapshotCommand } from '@/network/devices/linux/journal/JournalFollow';
import { splitChainText, splitPipeStages } from '@/network/devices/linux/LinuxShellParser';
import type { AsyncJobContext } from '@/terminal/async';

export interface StreamScreen {
  mark(): void;
  beginFrame(): void;
}

export interface StreamJobPlan {
  readonly kind: 'job';
  readonly jobKind: 'streaming' | 'subscription';
  readonly lineOriented: boolean;
  prepare?(ctx: AsyncJobContext): boolean;
  run(ctx: AsyncJobContext): Promise<void>;
  onInterrupt?(ctx: AsyncJobContext): void;
}

export interface StreamNoticePlan {
  readonly kind: 'notice';
  readonly lines: readonly string[];
}

export type StreamPlan = StreamJobPlan | StreamNoticePlan;

const PIPELINE = /[|<>&]/;
const SEQUENCE = /[|<>&;]/;

function emit(ctx: AsyncJobContext, text: string): void {
  for (const line of text.split('\n')) ctx.sink.line(line);
}

function notice(...lines: string[]): StreamNoticePlan {
  return { kind: 'notice', lines };
}

function job(
  run: (ctx: AsyncJobContext) => Promise<void>,
  extra: Pick<StreamJobPlan, 'prepare' | 'onInterrupt'> & { jobKind?: StreamJobPlan['jobKind']; lineOriented?: boolean } = {},
): StreamJobPlan {
  return { kind: 'job', jobKind: extra.jobKind ?? 'streaming', lineOriented: extra.lineOriented ?? true, prepare: extra.prepare, onInterrupt: extra.onInterrupt, run };
}

function follow(
  subscribe: (sink: (line: string) => void) => () => void,
  extra: Pick<StreamJobPlan, 'prepare'> & { jobKind?: StreamJobPlan['jobKind'] } = {},
): StreamJobPlan {
  return job((ctx) => new Promise<void>((resolve) => {
    if (ctx.cancelled()) { resolve(); return; }
    let unsubscribe: (() => void) | null = subscribe((line) => ctx.sink.line(line));
    ctx.onCancel(() => { unsubscribe?.(); unsubscribe = null; resolve(); });
  }), extra);
}

function scrolling(opts: {
  intervalMs: number;
  frame: () => Promise<string> | string;
  header?: () => string;
  trailer?: () => string;
  maxFrames?: number;
}): StreamJobPlan {
  let trailerEmitted = false;
  const emitTrailer = (ctx: AsyncJobContext): void => {
    if (trailerEmitted || !opts.trailer) return;
    trailerEmitted = true;
    const text = opts.trailer();
    if (text) emit(ctx, text);
  };
  return job(async (ctx) => {
    if (opts.header) {
      const header = opts.header();
      if (header) emit(ctx, header);
    }
    let emitted = 0;
    while (!ctx.cancelled() && (opts.maxFrames === undefined || emitted < opts.maxFrames)) {
      emit(ctx, await opts.frame());
      emitted++;
      if (opts.maxFrames !== undefined && emitted >= opts.maxFrames) break;
      await ctx.delay(opts.intervalMs);
    }
    emitTrailer(ctx);
  }, { onInterrupt: opts.trailer ? emitTrailer : undefined });
}

function repainting(screen: StreamScreen, frame: () => string, intervalMs: number): StreamJobPlan {
  return job(async (ctx) => {
    while (!ctx.cancelled()) {
      screen.beginFrame();
      emit(ctx, frame());
      await ctx.delay(intervalMs);
    }
  }, { prepare: () => { screen.mark(); return true; }, lineOriented: false });
}

function intervalOf(seconds: number): number {
  return Math.max(100, seconds * 1000);
}

const LINEWISE_FILTERS = new Set(['grep', 'egrep', 'fgrep', 'sed', 'awk', 'gawk', 'cut', 'tr', 'cat', 'stdbuf']);
const WHOLE_INPUT_GREP_FLAGS = /^-[A-Za-z]*[clLqm]|^--(count|files-with|files-without|quiet|silent|max-count)/;

function isLinewiseFilter(stage: string): boolean {
  const toks = stage.split(/\s+/);
  if (!LINEWISE_FILTERS.has(toks[0])) return false;
  if (/[<>&;]/.test(stage)) return false;
  if (toks[0].endsWith('grep') && toks.slice(1).some((t) => WHOLE_INPUT_GREP_FLAGS.test(t))) return false;
  if ((toks[0] === 'awk' || toks[0] === 'gawk') && /\b(END|BEGIN)\b/.test(stage)) return false;
  return true;
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function filteredContext(ctx: AsyncJobContext, passes: (line: string) => string): AsyncJobContext {
  let pending = '';
  const emitLine = (text: string, type?: string): void => {
    const out = passes(text);
    if (out.length > 0) for (const line of out.split('\n')) ctx.sink.line(line, type);
  };
  return {
    ...ctx,
    sink: {
      line: (text, type) => emitLine(text, type),
      lines: (texts, type) => { for (const text of texts) emitLine(text, type); },
      write: (chunk, type) => {
        pending += chunk;
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        for (const part of parts) emitLine(part, type);
      },
      warn: (text) => ctx.sink.warn(text),
      error: (text) => ctx.sink.error(text),
    },
  };
}

export function planLinuxStream(
  dev: LinuxMachine, session: LinuxShellSession, commandLine: string, screen: StreamScreen,
): StreamPlan | null {
  const chains = splitChainText(commandLine);
  if (chains.length > 1) return planSequence(dev, session, chains, screen);
  const stages = splitPipeStages(commandLine);
  if (stages.length <= 1) return planStage(dev, session, commandLine, screen);
  if (commandLine.includes('||')) return null;
  const filters = stages.slice(1);
  if (!filters.every(isLinewiseFilter)) return null;
  const head = planStage(dev, session, stages[0], screen);
  if (head === null || head.kind !== 'job' || !head.lineOriented) return null;
  const tail = filters.join(' | ');
  const passes = (line: string): string => dev.runCommandFrameInSession(`printf '%s\\n' ${shellQuote(line)} | ${tail}`, session).replace(/\n$/, '');
  return {
    ...head,
    prepare: head.prepare ? (ctx) => head.prepare!(filteredContext(ctx, passes)) : undefined,
    run: (ctx) => head.run(filteredContext(ctx, passes)),
    onInterrupt: head.onInterrupt ? (ctx) => head.onInterrupt!(filteredContext(ctx, passes)) : undefined,
  };
}

function planSequence(
  dev: LinuxMachine, session: LinuxShellSession, chains: ReturnType<typeof splitChainText>, screen: StreamScreen,
): StreamPlan | null {
  const prefix = chains.slice(0, -1);
  if (prefix.some((chain) => chain.operator !== ';' && chain.operator !== '&&')) return null;
  const last = planLinuxStream(dev, session, chains[chains.length - 1].text, screen);
  if (last === null || last.kind !== 'job') return null;
  let proceed = true;
  return {
    ...last,
    prepare: (ctx) => {
      let succeeded = true;
      let previous: typeof chains[number]['operator'] = ';';
      for (const chain of prefix) {
        if (previous === '&&' && !succeeded) { previous = chain.operator; continue; }
        const out = dev.runCommandFrameInSession(chain.text, session).replace(/\n$/, '');
        if (out.length > 0) emit(ctx, out);
        succeeded = session.lastExitCode === 0;
        previous = chain.operator;
      }
      proceed = previous === ';' || succeeded;
      return proceed && last.prepare ? last.prepare(ctx) : true;
    },
    run: (ctx) => (proceed ? last.run(ctx) : Promise.resolve()),
  };
}

function planStage(
  dev: LinuxMachine, session: LinuxShellSession, commandLine: string, screen: StreamScreen,
): StreamPlan | null {
  const toks = commandLine.trim().split(/\s+/);
  const verb = toks[0];
  switch (verb) {
    case 'tail': return planTail(dev, session, commandLine);
    case 'ping': case 'ping6': return planPing(dev, session, commandLine, toks);
    case 'sudo': case 'traceroute': case 'tcpdump': return planCapture(dev, session, commandLine);
    case 'mtr': return planMtr(dev, commandLine, toks, screen);
    case 'watch': return planWatch(dev, session, commandLine, toks, screen);
    case 'top': return planTop(dev, session, commandLine, toks, screen);
    case 'journalctl': return planJournal(dev, session, commandLine, toks);
    case 'ip': return planIpMonitor(dev, commandLine, toks);
    case 'dmesg': return planDmesg(dev, session, commandLine, toks);
    case 'netstat': return planNetstat(dev, session, commandLine, toks);
    case 'free': return planFree(dev, session, commandLine, toks);
    case 'vmstat': return planVmstat(dev, commandLine, toks);
    case 'mpstat': return planMpstat(dev, commandLine, toks);
    case 'pidstat': return planPidstat(dev, commandLine, toks);
    case 'iostat': return planIostat(dev, commandLine, toks);
    case 'dstat': return planDstat(dev, commandLine, toks);
    default: return null;
  }
}

function planTail(dev: LinuxMachine, session: LinuxShellSession, commandLine: string): StreamPlan {
  let handle: import('@/network/devices/linux/coreutils').TailFollowHandle | null = null;
  return job((ctx) => new Promise<void>((resolve) => {
    if (ctx.cancelled()) { resolve(); return; }
    ctx.onCancel(() => resolve());
  }), {
    prepare: (ctx) => {
      handle = dev.startTailFollowInSession(commandLine, session, {
        write: (chunk) => ctx.sink.write(chunk),
        warn: (msg) => ctx.sink.error(msg),
        error: (msg) => ctx.sink.error(msg),
      });
      if (!handle) return false;
      ctx.onCancel(() => handle?.cancel());
      return true;
    },
  });
}

function planPing(dev: LinuxMachine, session: LinuxShellSession, commandLine: string, toks: string[]): StreamPlan | null {
  if (SEQUENCE.test(commandLine)) return null;
  let ping: PingRun | null = null;
  return job(async (ctx) => {
    const host = dev.pingHostInSession(session, { sleep: (ms) => ctx.delay(ms), now: () => simulationNowMs() });
    ping = createPing(toks.slice(1), host, (line) => ctx.sink.line(line), { cmd: toks[0] as 'ping' | 'ping6' });
    await ping.run(() => ctx.cancelled());
  }, { onInterrupt: () => { ping?.interrupt(); } });
}

export function captureToolInvocation(commandLine: string): { argv: string[]; elevated: boolean } | null {
  if (SEQUENCE.test(commandLine)) return null;
  const toks = commandLine.trim().split(/\s+/);
  const elevated = toks[0] === 'sudo';
  const argv = elevated ? toks.slice(1) : toks;
  return argv[0] === 'traceroute' || argv[0] === 'tcpdump' ? { argv, elevated } : null;
}

function planCapture(dev: LinuxMachine, session: LinuxShellSession, commandLine: string): StreamPlan | null {
  const invocation = captureToolInvocation(commandLine);
  if (invocation === null) return null;
  if (invocation.elevated && session.uid !== 0) return null;
  return planCaptureTool(dev, session, invocation.argv, invocation.elevated);
}

export function planCaptureTool(dev: LinuxMachine, session: LinuxShellSession, argv: string[], elevated: boolean): StreamPlan {
  if (elevated) {
    const refusal = dev.sudoRefusalInSession(argv, session);
    if (refusal !== null) return notice(refusal);
  }
  return job(async (ctx) => {
    if (argv[0] === 'traceroute') {
      await runTraceroute(argv.slice(1), dev.tracerouteHostInSession(session, elevated), (text) => emit(ctx, text), () => ctx.cancelled());
      return;
    }
    const result = await runTcpdump(argv.slice(1), {
      ...dev.tcpdumpDepsInSession(session, elevated),
      stream: { line: (text) => ctx.sink.line(text) },
      onCancelRequested: (cb) => { ctx.onCancel(cb); return () => {}; },
      interruptEchoed: () => true,
    });
    const rest = interleaveTcpdumpStreams(result);
    if (rest) emit(ctx, rest);
  });
}

function planMtr(dev: LinuxMachine, commandLine: string, toks: string[], screen: StreamScreen): StreamPlan | null {
  if (PIPELINE.test(commandLine)) return null;
  const parsed = parseMtrArgs(toks.slice(1));
  if (parsed.showHelp) return notice(MTR_USAGE);
  if (parsed.showVersion) return notice(MTR_VERSION);
  if (parsed.parseError) return notice(parsed.parseError);
  if (!parsed.target) return notice('mtr: no host specified');
  const intervalMs = intervalOf(parsed.intervalSec);
  return job(async (ctx) => {
    const hopIps: (string | null)[] = [];
    let resolved = false;
    const discovery = await dev.tracerouteStreamInSession(parsed.target, {
      maxHops: parsed.maxHops,
      probesPerHop: 1,
      onResolved: () => { resolved = true; },
      onHop: (hop) => { hopIps.push(hop.ip ?? null); },
      shouldStop: () => ctx.cancelled(),
    });
    if (ctx.cancelled()) return;
    if (!discovery.resolved) { ctx.sink.error(`mtr: Failed to resolve host: ${parsed.target}`); return; }
    if (!resolved || hopIps.length === 0) { ctx.sink.error('mtr: no hops discovered'); return; }
    const stats = hopIps.map(() => new MtrHopStats());
    const startedAt = simulationDate();
    const hostname = dev.getHostname();
    const targetIp = hopIps[hopIps.length - 1] ?? parsed.target;
    const paint = (): void => {
      screen.beginFrame();
      emit(ctx, formatMtrFrame({ hostname, target: targetIp, startedAt, hops: stats }, parsed.reportMode ? 'report' : 'live'));
    };
    paint();
    for (let cycle = 0; ; cycle++) {
      if (ctx.cancelled()) return;
      if (parsed.reportMode && cycle >= parsed.cycles) break;
      for (let i = 0; i < hopIps.length; i++) {
        const ip = hopIps[i];
        let probe: MtrHopProbe;
        if (!ip) {
          probe = { lost: true };
        } else {
          try {
            const result = dev.sendPingProbeSync(new IPAddress(ip));
            probe = result.success ? { ip, rttMs: result.rttMs, lost: false } : { ip, lost: true };
          } catch {
            probe = { ip, lost: true };
          }
        }
        stats[i].record(probe);
      }
      paint();
      if (parsed.reportMode && cycle + 1 >= parsed.cycles) break;
      await ctx.delay(intervalMs);
    }
  }, { prepare: () => { screen.mark(); return true; }, lineOriented: false });
}

function planWatch(dev: LinuxMachine, session: LinuxShellSession, commandLine: string, toks: string[], screen: StreamScreen): StreamPlan | null {
  if (toks[0] !== 'watch') return null;
  let parsed: ReturnType<typeof parseWatchArgs>;
  try { parsed = parseWatchArgs(toks.slice(1)); } catch { return null; }
  if (parsed.command.length === 0) return null;
  return repainting(screen, () => dev.runCommandFrameInSession(commandLine, session), intervalOf(parsed.intervalSeconds));
}

function planTop(dev: LinuxMachine, session: LinuxShellSession, commandLine: string, toks: string[], screen: StreamScreen): StreamPlan | null {
  if (toks.includes('-n') || toks.includes('-b')) return null;
  const dIdx = toks.indexOf('-d');
  const delay = dIdx >= 0 ? parseFloat(toks[dIdx + 1]) : 3;
  const seconds = Number.isFinite(delay) && delay > 0 ? delay : 3;
  return repainting(screen, () => dev.runCommandFrameInSession(commandLine, session), intervalOf(seconds));
}

function planJournal(dev: LinuxMachine, session: LinuxShellSession, commandLine: string, toks: string[]): StreamPlan | null {
  if (!toks.includes('-f') && !toks.includes('--follow')) return null;
  if (PIPELINE.test(commandLine)) return null;
  const initialCommand = snapshotCommand(toks.slice(1));
  return follow((sink) => dev.followJournal(followArguments(toks.slice(1)), sink), {
    prepare: (ctx) => {
      const initial = dev.runCommandFrameInSession(initialCommand, session);
      if (initial.startsWith('No journal files')) { ctx.sink.line(initial); return false; }
      emit(ctx, initial);
      return true;
    },
  });
}

function planIpMonitor(dev: LinuxMachine, commandLine: string, toks: string[]): StreamPlan | null {
  if (PIPELINE.test(commandLine)) return null;
  let i = 1;
  while (i < toks.length && toks[i].startsWith('-')) i++;
  if (toks[i] !== 'monitor') return null;
  const spec = parseIpMonitorSpec(toks.slice(i + 1));
  if ('error' in spec) return notice(spec.error);
  return follow((sink) => dev.monitorNetlink(
    { objects: spec.objects, labelled: spec.labelled },
    (block) => { for (const line of block.split('\n')) sink(line); },
  ), { jobKind: 'subscription' });
}

function planDmesg(dev: LinuxMachine, session: LinuxShellSession, commandLine: string, toks: string[]): StreamPlan | null {
  if (PIPELINE.test(commandLine)) return null;
  if (!toks.includes('-w') && !toks.includes('--follow')) return null;
  let raw = false;
  let humanTime = false;
  let levelFilter: string[] = [];
  for (let i = 1; i < toks.length; i++) {
    const a = toks[i];
    if (a === '-T' || a === '--ctime' || a === '-H' || a === '--human') humanTime = true;
    else if (a === '-r' || a === '--raw') raw = true;
    else if (a === '-l' || a === '--level') levelFilter = (toks[++i] || '').split(',').map((l) => l.trim()).filter(Boolean);
    else if (a.startsWith('--level=')) levelFilter = a.slice(8).split(',').map((l) => l.trim()).filter(Boolean);
  }
  const initialCommand = ['dmesg', ...toks.slice(1).filter((t) => t !== '-w' && t !== '--follow')].join(' ');
  return follow((sink) => dev.followDmesg({ raw, humanTime, levelFilter }, sink), {
    prepare: (ctx) => {
      const initial = dev.runCommandFrameInSession(initialCommand, session);
      if (initial.startsWith('dmesg:') && !initial.includes('\n')) { ctx.sink.line(initial); return false; }
      if (initial) emit(ctx, initial);
      return true;
    },
  });
}

function planNetstat(dev: LinuxMachine, session: LinuxShellSession, commandLine: string, toks: string[]): StreamPlan | null {
  if (PIPELINE.test(commandLine)) return null;
  const continuous = toks.some((t) => t.startsWith('-') && !t.startsWith('--') && t.includes('c')) || toks.includes('--continuous');
  if (!continuous) return null;
  return scrolling({ intervalMs: 1000, frame: () => dev.runCommandFrameInSession(commandLine, session) });
}

function planFree(dev: LinuxMachine, session: LinuxShellSession, commandLine: string, toks: string[]): StreamPlan | null {
  if (PIPELINE.test(commandLine)) return null;
  let intervalSeconds: number | null = null;
  let count: number | null = null;
  const rest: string[] = [];
  for (let i = 1; i < toks.length; i++) {
    const a = toks[i];
    if ((a === '-s' || a === '--seconds') && toks[i + 1]) {
      const v = parseInt(toks[++i], 10);
      if (!Number.isFinite(v) || v <= 0) return null;
      intervalSeconds = v;
    } else if ((a === '-c' || a === '--count') && toks[i + 1]) {
      const v = parseInt(toks[++i], 10);
      if (!Number.isFinite(v) || v <= 0) return null;
      count = v;
    } else {
      rest.push(a);
    }
  }
  if (intervalSeconds === null) return null;
  const rendered = ['free', ...rest].join(' ').trim();
  return scrolling({
    intervalMs: intervalOf(intervalSeconds),
    maxFrames: count ?? undefined,
    frame: () => dev.runCommandFrameInSession(rendered, session),
  });
}

function planVmstat(dev: LinuxMachine, commandLine: string, toks: string[]): StreamPlan | null {
  if (PIPELINE.test(commandLine)) return null;
  const parsed = parseVmstatArgs(toks.slice(1));
  if ('error' in parsed || parsed.intervalSeconds === null) return null;
  return scrolling({
    intervalMs: intervalOf(parsed.intervalSeconds),
    maxFrames: parsed.count ?? undefined,
    header: () => vmstatHeader(parsed),
    frame: () => formatVmstatRow(dev.sampleVmstatSnapshot(), parsed),
  });
}

function planMpstat(dev: LinuxMachine, commandLine: string, toks: string[]): StreamPlan | null {
  if (PIPELINE.test(commandLine)) return null;
  const parsed = parseMpstatArgs(toks.slice(1));
  if ('error' in parsed || parsed.intervalSeconds === null) return null;
  const accumulator = new MpstatAccumulator();
  return scrolling({
    intervalMs: intervalOf(parsed.intervalSeconds),
    maxFrames: parsed.count ?? undefined,
    header: () => `${dev.mpstatBannerLine()}\n${mpstatColumnHeader(simulationDate())}`,
    frame: () => {
      const rows = dev.sampleMpstatSnapshot(parsed);
      accumulator.add(rows);
      const now = simulationDate();
      return rows.map((r) => formatMpstatRow(now, r)).join('\n');
    },
    trailer: () => (accumulator.sampleCount() === 0 ? '' : ['', ...accumulator.averages().map((r) => formatMpstatAverageRow(r))].join('\n')),
  });
}

function planPidstat(dev: LinuxMachine, commandLine: string, toks: string[]): StreamPlan | null {
  if (PIPELINE.test(commandLine)) return null;
  const parsed = parsePidstatArgs(toks.slice(1));
  if ('error' in parsed || parsed.intervalSeconds === null) return null;
  const common = {
    intervalMs: intervalOf(parsed.intervalSeconds),
    maxFrames: parsed.count ?? undefined,
    header: () => `${dev.pidstatBannerLine()}\n${pidstatColumnHeader(parsed, simulationDate())}`,
  };
  if (parsed.report === 'cpu') {
    const accumulator = new PidstatAccumulator<PidstatCpuRow>('cpu');
    return scrolling({
      ...common,
      frame: () => {
        const rows = dev.samplePidstatCpu(parsed);
        accumulator.add(rows);
        const now = simulationDate();
        return rows.map((r) => formatPidstatCpuRow(now, r)).join('\n');
      },
      trailer: () => (accumulator.sampleCount() === 0 ? '' : ['', ...accumulator.averages().map((r) => formatPidstatAverageCpuRow(r))].join('\n')),
    });
  }
  const accumulator = new PidstatAccumulator<PidstatMemRow>('memory');
  return scrolling({
    ...common,
    frame: () => {
      const rows = dev.samplePidstatMemory(parsed);
      accumulator.add(rows);
      const now = simulationDate();
      return rows.map((r) => formatPidstatMemRow(now, r)).join('\n');
    },
    trailer: () => (accumulator.sampleCount() === 0 ? '' : ['', ...accumulator.averages().map((r) => formatPidstatAverageMemRow(r))].join('\n')),
  });
}

function planIostat(dev: LinuxMachine, commandLine: string, toks: string[]): StreamPlan | null {
  if (PIPELINE.test(commandLine)) return null;
  const parsed = parseIostatArgs(toks.slice(1));
  if ('error' in parsed || parsed.intervalSeconds === null) return null;
  return scrolling({
    intervalMs: intervalOf(parsed.intervalSeconds),
    maxFrames: parsed.count ?? undefined,
    header: () => dev.iostatBannerLine(),
    frame: () => `\n${renderIostatReport(parsed, dev.sampleIostatCpuSnapshot(), dev.sampleIostatDevicesSnapshot(parsed), simulationDate())}`,
  });
}

function planDstat(dev: LinuxMachine, commandLine: string, toks: string[]): StreamPlan | null {
  if (PIPELINE.test(commandLine)) return null;
  const parsed = parseDstatArgs(toks.slice(1));
  if (parsed.showHelp) return notice(DSTAT_USAGE);
  if (parsed.showVersion) return notice(DSTAT_VERSION);
  if (parsed.listStats) return notice(DSTAT_LISTING);
  if (parsed.parseError) return notice(parsed.parseError);
  const rate = newDstatRateState();
  return scrolling({
    intervalMs: intervalOf(parsed.intervalSeconds),
    maxFrames: parsed.count ?? undefined,
    header: () => formatDstatHeader(parsed.groups),
    frame: () => formatDstatRow(dev.sampleDstatSnapshot(rate), parsed.groups),
  });
}
