export const WATCH_USAGE = "\nUsage:\n watch [options] command\n\nOptions:\n  -b, --beep             beep if command has a non-zero exit\n  -c, --color            interpret ANSI color and style sequences\n  -C, --no-color         do not interpret ANSI color and style sequences\n  -d, --differences[=<permanent>]\n                         highlight changes between updates\n  -e, --errexit          exit if command has a non-zero exit\n  -g, --chgexit          exit when output from command changes\n  -q, --equexit <cycles>\n                         exit when output from command does not change\n  -n, --interval <secs>  seconds to wait between updates\n  -p, --precise          attempt run command in precise intervals\n  -r, --no-rerun         do not rerun program on window resize\n  -t, --no-title         turn off header\n  -w, --no-wrap          turn off line wrapping\n  -x, --exec             pass command to exec instead of \"sh -c\"\n\n -h, --help     display this help and exit\n -v, --version  output version information and exit\n\nFor more details see watch(1).\n".replace(/\n$/, '');

export const WATCH_VERSION = 'watch from procps-ng 4.0.4';

const MINIMUM_INTERVAL_SECONDS = 0.1;
const SCREEN_COLUMNS = 80;

export interface WatchOptions {
  intervalSeconds: number;
  showHeader: boolean;
  differences: boolean;
  permanentDifferences: boolean;
  beepOnError: boolean;
  exitOnError: boolean;
  exitOnChange: boolean;
  exitOnEqualCycles: number | null;
  precise: boolean;
  color: boolean;
  noWrap: boolean;
  noRerun: boolean;
  exec: boolean;
  iterations: number;
  command: string[];
  informational: 'help' | 'version' | null;
}

export interface WatchResult {
  output: string;
  exitCode: number;
  options: WatchOptions;
}

export class WatchUsageError extends Error {
  constructor(readonly diagnostic: string | null) {
    super(diagnostic ?? 'usage');
  }
}

function defaultOptions(): WatchOptions {
  return {
    intervalSeconds: 2, showHeader: true, differences: false, permanentDifferences: false,
    beepOnError: false, exitOnError: false, exitOnChange: false, exitOnEqualCycles: null,
    precise: false, color: false, noWrap: false, noRerun: false, exec: false,
    iterations: 1, command: [], informational: null,
  };
}

function numericArgument(raw: string): number {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) throw new WatchUsageError(`watch: failed to parse argument: '${raw}': Invalid argument`);
  return Number.parseFloat(raw);
}

function intervalArgument(raw: string): number {
  const seconds = numericArgument(raw);
  return seconds < MINIMUM_INTERVAL_SECONDS ? MINIMUM_INTERVAL_SECONDS : seconds;
}

const SHORT_WITH_ARGUMENT = new Set(['n', 'q']);

export function parseWatchArgs(argv: readonly string[]): WatchOptions {
  const o = defaultOptions();
  const apply = (flag: string, value: string | undefined): void => {
    switch (flag) {
      case 'b': o.beepOnError = true; break;
      case 'c': o.color = true; break;
      case 'C': o.color = false; break;
      case 'd': o.differences = true; o.permanentDifferences = value === 'permanent'; break;
      case 'e': o.exitOnError = true; break;
      case 'g': o.exitOnChange = true; break;
      case 'q': o.exitOnEqualCycles = Math.trunc(numericArgument(value ?? '')); break;
      case 'n': o.intervalSeconds = intervalArgument(value ?? ''); break;
      case 'p': o.precise = true; break;
      case 'r': o.noRerun = true; break;
      case 't': o.showHeader = false; break;
      case 'w': o.noWrap = true; break;
      case 'x': o.exec = true; break;
      case 'h': o.informational = 'help'; break;
      case 'v': o.informational = 'version'; break;
    }
  };
  const LONG: Record<string, { flag: string; argument: 'none' | 'required' | 'optional' }> = {
    beep: { flag: 'b', argument: 'none' }, color: { flag: 'c', argument: 'none' }, 'no-color': { flag: 'C', argument: 'none' },
    differences: { flag: 'd', argument: 'optional' }, errexit: { flag: 'e', argument: 'none' }, chgexit: { flag: 'g', argument: 'none' },
    equexit: { flag: 'q', argument: 'required' }, interval: { flag: 'n', argument: 'required' }, precise: { flag: 'p', argument: 'none' },
    'no-rerun': { flag: 'r', argument: 'none' }, 'no-title': { flag: 't', argument: 'none' }, 'no-wrap': { flag: 'w', argument: 'none' },
    exec: { flag: 'x', argument: 'none' }, help: { flag: 'h', argument: 'none' }, version: { flag: 'v', argument: 'none' },
  };
  let i = 0;
  while (i < argv.length) {
    const word = argv[i];
    if (word === '--') { i++; break; }
    if (word.startsWith('--')) {
      const [name, inline] = word.slice(2).split(/=(.*)/s, 2);
      const matches = Object.keys(LONG).filter((candidate) => candidate === name);
      const known = matches.length === 1 ? LONG[matches[0]] : undefined;
      if (known === undefined) throw new WatchUsageError(`watch: unrecognized option '${word}'`);
      let value = inline;
      if (known.argument === 'required' && value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new WatchUsageError(`watch: option '--${name}' requires an argument`);
      }
      apply(known.flag, value);
      i++;
      continue;
    }
    if (word.startsWith('-') && word.length > 1) {
      for (let k = 1; k < word.length; k++) {
        const flag = word[k];
        if (!'bcCdeghnpqrtvwx'.includes(flag)) throw new WatchUsageError(`watch: invalid option -- '${flag}'`);
        if (flag === 'd' && word[k + 1] === '=') { apply('d', word.slice(k + 2)); break; }
        if (SHORT_WITH_ARGUMENT.has(flag)) {
          let value = word.slice(k + 1);
          if (value === '') {
            value = argv[++i] as string;
            if (value === undefined) throw new WatchUsageError(`watch: option requires an argument -- '${flag}'`);
          }
          apply(flag, value);
          break;
        }
        apply(flag, undefined);
      }
      i++;
      continue;
    }
    break;
  }
  o.command = argv.slice(i).slice();
  return o;
}

export interface WatchRuntime {
  hostname: string;
  now(): string;
  run(command: string[]): { output: string; exitCode: number };
}

export function watchHeader(options: WatchOptions, hostname: string, clock: string): string {
  const left = `Every ${options.intervalSeconds.toFixed(1)}s: ${options.command.join(' ')}`;
  const right = `${hostname}: ${clock}`;
  const gap = SCREEN_COLUMNS - left.length - right.length;
  return gap >= 1 ? `${left}${' '.repeat(gap)}${right}` : `${left} ${right}`;
}

export function runWatch(argv: readonly string[], rt: WatchRuntime): WatchResult {
  let opts: WatchOptions;
  try { opts = parseWatchArgs(argv); }
  catch (e) {
    if (!(e instanceof WatchUsageError)) throw e;
    const lead = e.diagnostic === null ? '' : `${e.diagnostic}\n`;
    const needsUsage = !(e.diagnostic ?? '').includes('failed to parse');
    return { output: needsUsage ? `${lead}${WATCH_USAGE}` : e.diagnostic ?? '', exitCode: 1, options: defaultOptions() };
  }
  if (opts.informational === 'version') return { output: WATCH_VERSION, exitCode: 0, options: opts };
  if (opts.informational === 'help') return { output: WATCH_USAGE, exitCode: 0, options: opts };
  if (opts.command.length === 0) return { output: WATCH_USAGE, exitCode: 1, options: opts };
  const inner = rt.run(opts.command);
  const lines: string[] = [];
  if (opts.showHeader) {
    lines.push(watchHeader(opts, rt.hostname, rt.now()));
    lines.push('');
  }
  if (inner.output) lines.push(inner.output);
  return { output: lines.join('\n'), exitCode: inner.exitCode, options: opts };
}
