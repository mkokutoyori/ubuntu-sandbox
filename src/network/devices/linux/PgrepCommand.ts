import type { Signal } from './LinuxProcessManager';
import type { ProcessCmdContext, KillResult } from './LinuxProcessCommands';
import { parseSignalArg } from './LinuxProcessCommands';

const COMM_LIMIT = 15;
const VERSION = 'pgrep from procps-ng 4.0.4';

interface Selection {
  list: boolean;
  full: boolean;
  inverse: boolean;
  count: boolean;
  commandLine: boolean;
  ignoreCase: boolean;
  newest: boolean;
  oldest: boolean;
  exact: boolean;
  delimiter: string;
  olderThan: number | null;
  parents: number[] | null;
  groups: number[] | null;
  sessions: number[] | null;
  terminals: string[] | null;
  euids: number[] | null;
  uids: number[] | null;
  gids: number[] | null;
  pidfile: string | null;
  runStates: ReadonlySet<string> | null;
  signal: Signal;
  version: boolean;
  pattern: string | null;
}

type Fail = { failure: KillResult };

const SHORT_VALUED = new Set(['d', 'g', 'G', 'O', 'P', 's', 't', 'u', 'U', 'F', 'r']);
const LONG_TO_SHORT: Readonly<Record<string, string>> = {
  delimiter: 'd', 'list-name': 'l', 'list-full': 'a', inverse: 'v', lightweight: 'w', count: 'c', full: 'f',
  pgroup: 'g', group: 'G', 'ignore-case': 'i', newest: 'n', oldest: 'o', older: 'O', parent: 'P', session: 's',
  terminal: 't', euid: 'u', uid: 'U', exact: 'x', pidfile: 'F', version: 'V', signal: 'S', runstates: 'r',
};

function usageFailure(program: string, line: string, status: number): Fail {
  return { failure: { output: '', stderr: `${program}: ${line}\nTry \`${program} --help' for more information.\n`, exitCode: status } };
}

function numbers(program: string, text: string): number[] | Fail {
  const out: number[] = [];
  for (const item of text.split(',').filter(Boolean)) {
    if (!/^-?\d+$/.test(item)) return { failure: { output: '', stderr: `${program}: not a number: ${item}\n`, exitCode: 2 } };
    out.push(Number(item));
  }
  return out;
}

function identities(
  program: string, text: string, resolve: ((name: string) => number) | undefined, kind: 'user' | 'group',
): number[] | Fail {
  const out: number[] = [];
  for (const item of text.split(',').filter(Boolean)) {
    if (/^\d+$/.test(item)) { out.push(Number(item)); continue; }
    const id = resolve?.(item) ?? -1;
    if (id < 0) return { failure: { output: '', stderr: `${program}: invalid ${kind} name: ${item}\n`, exitCode: 2 } };
    out.push(id);
  }
  return out;
}

function parseSelection(program: 'pgrep' | 'pkill', args: readonly string[], ctx: ProcessCmdContext): Selection | Fail {
  const selection: Selection = {
    list: false, full: false, inverse: false, count: false, commandLine: false, ignoreCase: false,
    newest: false, oldest: false, exact: false, delimiter: '\n', olderThan: null, parents: null, groups: null,
    sessions: null, terminals: null, euids: null, uids: null, gids: null, pidfile: null, runStates: null,
    signal: 'SIGTERM', version: false, pattern: null,
  };
  const patterns: string[] = [];
  const valued = (letter: string, value: string): Fail | null => {
    const asNumbers = (): number[] | Fail => numbers(program, value);
    switch (letter) {
      case 'd': selection.delimiter = value; return null;
      case 'F': selection.pidfile = value; return null;
      case 'r': selection.runStates = new Set(value.replace(/[^A-Za-z]/g, '').split('')); return null;
      case 'O': { const n = asNumbers(); if ('failure' in n) return n; selection.olderThan = n[0] ?? 0; return null; }
      case 'P': { const n = asNumbers(); if ('failure' in n) return n; selection.parents = n; return null; }
      case 'g': { const n = asNumbers(); if ('failure' in n) return n; selection.groups = n; return null; }
      case 's': { const n = asNumbers(); if ('failure' in n) return n; selection.sessions = n; return null; }
      case 't': selection.terminals = value.split(',').filter(Boolean); return null;
      case 'u': { const n = identities(program, value, ctx.userUid, 'user'); if ('failure' in n) return n; selection.euids = n; return null; }
      case 'U': { const n = identities(program, value, ctx.userUid, 'user'); if ('failure' in n) return n; selection.uids = n; return null; }
      case 'G': { const n = identities(program, value, ctx.groupGid, 'group'); if ('failure' in n) return n; selection.gids = n; return null; }
      case 'S': {
        const sig = parseSignalArg(value);
        if (sig === null) return usageFailure(program, `Unknown signal: ${value}`, 2);
        selection.signal = sig;
        return null;
      }
      default: return null;
    }
  };
  const flag = (letter: string): void => {
    if (letter === 'l') selection.list = true;
    else if (letter === 'a') selection.full = true;
    else if (letter === 'v') selection.inverse = true;
    else if (letter === 'c') selection.count = true;
    else if (letter === 'f') selection.commandLine = true;
    else if (letter === 'i') selection.ignoreCase = true;
    else if (letter === 'n') selection.newest = true;
    else if (letter === 'o') selection.oldest = true;
    else if (letter === 'x') selection.exact = true;
    else if (letter === 'V') selection.version = true;
  };
  let optionsEnded = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (optionsEnded || !token.startsWith('-') || token === '-') { patterns.push(token); continue; }
    if (token === '--') { optionsEnded = true; continue; }
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split(/=(.*)/s);
      const letter = LONG_TO_SHORT[name];
      if (letter === undefined) continue;
      if (SHORT_VALUED.has(letter) || letter === 'S') {
        const failure = valued(letter, inline ?? args[++index] ?? '');
        if (failure !== null) return failure;
      } else flag(letter);
      continue;
    }
    if (program === 'pkill' && /^-(\d+|[A-Za-z]+)$/.test(token) && parseSignalArg(token) !== null && !/^-[a-z]$/.test(token)) {
      selection.signal = parseSignalArg(token)!;
      continue;
    }
    for (let at = 1; at < token.length; at++) {
      const letter = token[at];
      if (SHORT_VALUED.has(letter)) {
        const rest = token.slice(at + 1);
        const failure = valued(letter, rest !== '' ? rest : args[++index] ?? '');
        if (failure !== null) return failure;
        break;
      }
      flag(letter);
    }
  }
  selection.pattern = patterns[0] ?? null;
  return selection;
}

function pidfileFailure(program: string): Fail {
  return usageFailure(program, 'pidfile not valid', 1);
}

export function runPgrep(program: 'pgrep' | 'pkill', args: readonly string[], ctx: ProcessCmdContext): KillResult {
  const parsed = parseSelection(program, args, ctx);
  if ('failure' in parsed) return parsed.failure;
  const selection = parsed;
  if (selection.version) return { output: VERSION.replace('pgrep', program), exitCode: 0 };
  let pidfilePid: number | null = null;
  if (selection.pidfile !== null) {
    const content = ctx.readFile?.(selection.pidfile) ?? null;
    const pid = content === null ? NaN : Number(/^\s*(\d+)/.exec(content)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0) return pidfileFailure(program).failure;
    pidfilePid = pid;
  }
  const filtered = pidfilePid !== null || selection.runStates !== null || selection.pattern !== null || selection.parents !== null || selection.groups !== null
    || selection.sessions !== null || selection.terminals !== null || selection.euids !== null
    || selection.uids !== null || selection.gids !== null || selection.olderThan !== null;
  if (!filtered) return usageFailure(program, 'no matching criteria specified', 2).failure;
  if (selection.newest && selection.oldest) {
    return usageFailure(program, 'only one of -n or -o may be specified', 2).failure;
  }

  let matcher: RegExp | null = null;
  if (selection.pattern !== null) {
    const source = selection.exact ? `^(${selection.pattern})$` : selection.pattern;
    try {
      matcher = new RegExp(source, selection.ignoreCase ? 'i' : '');
    } catch {
      return { output: '', stderr: `${program}: regex error: Unmatched ( or \\(\n`, exitCode: 2 };
    }
  }
  const warning = !selection.commandLine && selection.pattern !== null && selection.pattern.length > COMM_LIMIT
    ? `${program}: pattern that searches for process name longer than ${COMM_LIMIT} characters will result in zero matches\nTry \`${program} -f' option to match against the complete command line.\n`
    : '';

  const now = Date.now();
  const self = ctx.currentPid;
  let hits = ctx.pm.list().filter((process) => {
    if (process.pid === self) return false;
    if (pidfilePid !== null && process.pid !== pidfilePid) return false;
    if (selection.runStates !== null && !selection.runStates.has(process.state)) return false;
    if (matcher !== null) {
      const subject = selection.commandLine ? process.command : process.comm.replace(/^\[(.*)\]$/, '$1').slice(0, COMM_LIMIT);
      if (!matcher.test(subject)) return false;
    }
    if (selection.parents !== null && !selection.parents.includes(process.ppid)) return false;
    if (selection.groups !== null && !selection.groups.includes(process.pgid)) return false;
    if (selection.sessions !== null && !selection.sessions.includes(process.sid)) return false;
    if (selection.terminals !== null && !selection.terminals.includes(process.tty)) return false;
    if (selection.euids !== null && !selection.euids.includes(process.uid)) return false;
    if (selection.uids !== null && !selection.uids.includes(process.uid)) return false;
    if (selection.gids !== null && !selection.gids.includes(process.gid)) return false;
    if (selection.olderThan !== null && now - process.startTime.getTime() < selection.olderThan * 1000) return false;
    return true;
  });
  if (selection.inverse) {
    const matched = new Set(hits.map((process) => process.pid));
    hits = ctx.pm.list().filter((process) => process.pid !== self && !matched.has(process.pid));
  }
  hits.sort((a, b) => a.pid - b.pid);
  if ((selection.newest || selection.oldest) && hits.length > 0) {
    const byStart = [...hits].sort((a, b) => a.startTime.getTime() - b.startTime.getTime() || a.pid - b.pid);
    hits = [selection.newest ? byStart[byStart.length - 1] : byStart[0]];
  }

  if (program === 'pkill') {
    let signalled = 0;
    for (const process of hits) if (ctx.pm.kill(process.pid, selection.signal)) signalled++;
    return { output: '', ...(warning === '' ? {} : { stderr: warning }), exitCode: hits.length > 0 ? 0 : 1 };
  }
  if (selection.count) {
    return { output: String(hits.length), ...(warning === '' ? {} : { stderr: warning }), exitCode: hits.length > 0 ? 0 : 1 };
  }
  const lines = hits.map((process) => (
    selection.full ? `${process.pid} ${process.command}` : selection.list ? `${process.pid} ${process.comm.replace(/^\[(.*)\]$/, '$1')}` : String(process.pid)
  ));
  return { output: lines.join(selection.delimiter), ...(warning === '' ? {} : { stderr: warning }), exitCode: hits.length > 0 ? 0 : 1 };
}

export function runPidof(args: readonly string[], ctx: ProcessCmdContext): KillResult {
  let single = false;
  let quiet = false;
  let separator = ' ';
  const omitted = new Set<number>();
  const names: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '-s') single = true;
    else if (token === '-q') quiet = true;
    else if (token === '-S') separator = args[++index] ?? ' ';
    else if (token.startsWith('-S')) separator = token.slice(2);
    else if (token === '-o') {
      for (const item of (args[++index] ?? '').split(',')) {
        if (item === '%PPID') omitted.add(ctx.currentPid ?? -1);
        else if (/^\d+$/.test(item)) omitted.add(Number(item));
      }
    } else if (token.startsWith('-')) continue;
    else names.push(token);
  }
  const found = new Set<number>();
  for (const name of names) {
    const base = name.slice(name.lastIndexOf('/') + 1);
    for (const pid of ctx.pm.pidof(base)) if (!omitted.has(pid)) found.add(pid);
  }
  const pids = [...found].sort((a, b) => b - a);
  const shown = single ? pids.slice(0, 1) : pids;
  if (shown.length === 0) return { output: '', exitCode: 1 };
  return { output: quiet ? '' : shown.join(separator), exitCode: 0 };
}
