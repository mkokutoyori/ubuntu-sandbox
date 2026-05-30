/**
 * `watch` — periodic command runner.
 *
 * Real `watch(1)` re-renders an alternate screen every `-n` seconds.
 * The simulator is synchronous, so we run the inner command once,
 * synthesize the canonical `Every Ns: CMD     HOSTNAME: HH:MM:SS`
 * header (unless `-t`) and return the body. Multi-iteration is
 * surfaced via the `iterations` field so callers (or tests) can
 * choose to re-run programmatically.
 */

export interface WatchOptions {
  intervalSeconds: number;   // -n
  showHeader: boolean;       // !-t
  differences: boolean;      // -d
  beepOnError: boolean;      // -b
  exitOnError: boolean;      // -e
  exitOnChange: boolean;     // -g
  precise: boolean;          // -p
  color: boolean;            // -c
  iterations: number;        // virtual loop count for the simulator (always 1 here)
  command: string[];
}

export interface WatchResult {
  output: string;
  exitCode: number;
  options: WatchOptions;
}

/**
 * Parse the watch flag set. Supports both `-nN`/`-n N` and the
 * `--name=` long forms. Unknown long flags are accepted as no-ops to
 * stay forgiving when scripts pass `--no-color` etc.
 */
export function parseWatchArgs(argv: readonly string[]): WatchOptions {
  const o: WatchOptions = {
    intervalSeconds: 2,
    showHeader: true,
    differences: false,
    beepOnError: false,
    exitOnError: false,
    exitOnChange: false,
    precise: false,
    color: false,
    iterations: 1,
    command: [],
  };
  let i = 0;
  const takeNum = (raw: string | undefined, flag: string): number => {
    if (raw === undefined) throw new Error(`watch: option requires an argument -- '${flag}'`);
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`watch: invalid interval '${raw}'`);
    return n;
  };
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { o.command = argv.slice(i + 1).slice(); break; }
    if (a === '-n' || a === '--interval') { o.intervalSeconds = takeNum(argv[++i], 'n'); i++; continue; }
    if (a.startsWith('-n') && a.length > 2)  { o.intervalSeconds = takeNum(a.slice(2), 'n'); i++; continue; }
    if (a.startsWith('--interval='))         { o.intervalSeconds = takeNum(a.slice('--interval='.length), 'n'); i++; continue; }
    if (a === '-t' || a === '--no-title')    { o.showHeader = false; i++; continue; }
    if (a === '-d' || a === '--differences') { o.differences = true; i++; continue; }
    if (a === '-b' || a === '--beep')        { o.beepOnError = true; i++; continue; }
    if (a === '-e' || a === '--errexit')     { o.exitOnError = true; i++; continue; }
    if (a === '-g' || a === '--chgexit')     { o.exitOnChange = true; i++; continue; }
    if (a === '-p' || a === '--precise')     { o.precise = true; i++; continue; }
    if (a === '-c' || a === '--color')       { o.color = true; i++; continue; }
    if (a.startsWith('-')) { i++; continue; }   // accept unknowns silently
    o.command = argv.slice(i).slice();
    break;
  }
  return o;
}

export interface WatchRuntime {
  hostname: string;
  /** HH:MM:SS local time for the header. */
  now(): string;
  run(command: string[]): { output: string; exitCode: number };
}

/**
 * Render one watch "frame". The hostname/clock pair on the header
 * line matches the procps-ng layout: command on the left, "HOST: TIME"
 * right-aligned to 80 columns when feasible (we left-pad with a tab
 * separator so the test surface is stable without depending on width).
 */
export function runWatch(argv: readonly string[], rt: WatchRuntime): WatchResult {
  let opts: WatchOptions;
  try { opts = parseWatchArgs(argv); }
  catch (e) {
    const msg = e instanceof Error ? e.message : 'watch: error';
    return { output: msg, exitCode: 1, options: parseFallback(argv) };
  }
  if (opts.command.length === 0) {
    return { output: 'watch: no command given', exitCode: 1, options: opts };
  }
  const inner = rt.run(opts.command);
  const lines: string[] = [];
  if (opts.showHeader) {
    const cmd = opts.command.join(' ');
    lines.push(`Every ${opts.intervalSeconds}s: ${cmd}\t${rt.hostname}: ${rt.now()}`);
    lines.push('');
  }
  if (inner.output) lines.push(inner.output);
  return { output: lines.join('\n'), exitCode: inner.exitCode, options: opts };
}

function parseFallback(argv: readonly string[]): WatchOptions {
  return {
    intervalSeconds: 2, showHeader: true, differences: false, beepOnError: false,
    exitOnError: false, exitOnChange: false, precise: false, color: false,
    iterations: 1, command: argv.filter(a => !a.startsWith('-')),
  };
}
