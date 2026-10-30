/**
 * GNU `tail(1)` — one-shot snapshot **and** streaming follow mode.
 *
 * Snapshot mode (`tail`, `tail -n N`, `tail -c N`, `tail file …`) is a
 * pure function of the filesystem state. Follow mode (`tail -f file …`)
 * is a long-lived subscription: the tail engine subscribes to per-path
 * `VirtualFileSystem` write events and emits each newly-appended line
 * (or byte) into a caller-provided `TailSink`. The caller controls the
 * lifetime via the returned `TailFollowHandle.cancel()` (Ctrl+C in the
 * terminal layer).
 *
 *   `-n N`         last N lines (default 10)
 *   `-n +N`        starting at line N (1-indexed)
 *   `-c N`         last N bytes
 *   `-c +N`        starting at byte N
 *   `-f`           follow by path (default)
 *   `-F`           follow + retry on missing/rotated files
 *   `-q`           never print file headers
 *   `-v`           always print file headers
 *   `--retry`      keep retrying when the file is missing
 *   `--pid=PID`    stop following when PID exits   (recognised; no-op)
 *   `-s, --sleep-interval N`  poll interval         (recognised; no-op)
 *   `--max-unchanged-stats N` rotation-detect cap   (recognised; no-op)
 *   multi-file: header `==> path <==` switches when the source changes
 */

import type { VfsWriteEvent } from '../VirtualFileSystem';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { Streams, docsResult, parseSizeWithSuffix, quoteLocale, quoteShell, takeBytes, utf8Bytes } from './CoreutilsKit';

export interface TailOptions {
  /** Positive: take last N. Negative-flagged via `fromStart`. */
  count: number;
  unit: 'lines' | 'bytes';
  /** `+N` form: emit starting *from* offset N. */
  fromStart: boolean;
  follow: 'none' | 'descriptor' | 'name';   // -f / -F
  retry: boolean;                            // --retry
  quiet: boolean;                            // -q
  verbose: boolean;                          // -v
  pid: number | null;                        // --pid=
  sleepIntervalSeconds: number;              // -s / --sleep-interval
  maxUnchangedStats: number;                 // --max-unchanged-stats
  zeroTerminated: boolean;                   // -z (lines split on NUL)
  files: string[];
}

/** Snapshot result returned by `TailCommand.runOnce`. */
export interface TailSnapshot {
  output: string;
  exitCode: number;
  stderr?: string;
  interleaved?: string;
}

/** Streaming sink, supplied by the terminal layer for follow mode. */
export interface TailSink {
  /** Append a chunk (may contain `\n`). Called once per VFS write event. */
  write(text: string): void;
  /** Print a non-fatal warning (missing file, rotation notice). */
  warn?(text: string): void;
  /** Surface a fatal error and end the stream. */
  error?(text: string): void;
}

/** Handle returned by `startFollow`. `cancel()` is idempotent. */
export interface TailFollowHandle {
  readonly active: boolean;
  cancel(): void;
  /** Files currently being followed. */
  readonly files: ReadonlyArray<string>;
}

export interface TailFs {
  readFile(path: string): string | null;
  exists(path: string): boolean;
  onWrite(path: string, listener: (e: VfsWriteEvent) => void): () => void;
  normalizePath(path: string, cwd: string): string;
  isDirectory?(path: string): boolean;
}

const DEFAULT_OPTIONS: Omit<TailOptions, 'files'> = {
  count: 10,
  unit: 'lines',
  fromStart: false,
  follow: 'none',
  retry: false,
  quiet: false,
  verbose: false,
  pid: null,
  sleepIntervalSeconds: 1,
  maxUnchangedStats: 5,
  zeroTerminated: false,
};

class TailArgsError extends Error {
  constructor(message: string, readonly usage = false) { super(message); }
}

class TailDocsSignal extends Error {
  constructor(readonly which: 'help' | 'version') { super(which); }
}

const TAIL_LONG_OPTIONS: readonly LongOption[] = [
  { name: 'bytes', letter: 'c', takesArgument: true },
  { name: 'follow', letter: 'f', takesArgument: false, optionalArgument: true },
  { name: 'lines', letter: 'n', takesArgument: true },
  { name: 'max-unchanged-stats', letter: 'M', takesArgument: true },
  { name: 'pid', letter: 'P', takesArgument: true },
  { name: 'quiet', letter: 'q', takesArgument: false },
  { name: 'retry', letter: 'R', takesArgument: false },
  { name: 'silent', letter: 'q', takesArgument: false },
  { name: 'sleep-interval', letter: 's', takesArgument: true },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'zero-terminated', letter: 'z', takesArgument: false },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

/**
 * Parse the argv that follows `tail` into a structured `TailOptions`.
 * Supports clustered short flags (`-fn5`), `-n+5`, `--lines=+5`, and the
 * historical `-N` / `+N` (first argument only, as in coreutils).
 */
export function parseTailArgs(argv: readonly string[]): TailOptions {
  const opts: TailOptions = { ...DEFAULT_OPTIONS, files: [] };
  const setCount = (raw: string, unit: 'lines' | 'bytes') => {
    const parsed = parseSizeWithSuffix(raw.replace(/^[-+]/, ''));
    if (parsed === null) throw new TailArgsError(`invalid number of ${unit}: ${quoteLocale(raw)}`);
    opts.count = parsed;
    opts.unit = unit;
    opts.fromStart = raw.startsWith('+');
  };
  let rest = argv;
  const obsolete = /^([-+])(\d+)([bkm]?)([cfqv]*)$/.exec(argv[0] ?? '');
  if (obsolete !== null) {
    const factor = obsolete[3] === 'b' ? 512 : obsolete[3] === 'k' ? 1024 : obsolete[3] === 'm' ? 1024 ** 2 : 1;
    opts.count = Number(obsolete[2]) * factor;
    opts.unit = obsolete[4].includes('c') ? 'bytes' : 'lines';
    opts.fromStart = obsolete[1] === '+';
    if (obsolete[4].includes('f')) opts.follow = 'descriptor';
    if (obsolete[4].includes('q')) { opts.quiet = true; opts.verbose = false; }
    if (obsolete[4].includes('v')) { opts.verbose = true; opts.quiet = false; }
    rest = argv.slice(1);
  }
  for (const item of shortOptions(rest, 'c:n:fFqs:vz', TAIL_LONG_OPTIONS)) {
    if (item.kind === 'operand') { opts.files.push(item.value); continue; }
    if (item.kind !== 'option') throw new TailArgsError(getoptDiagnostic('tail', item).replace(/^tail: /, ''), true);
    switch (item.letter) {
      case 'H': throw new TailDocsSignal('help');
      case 'V': throw new TailDocsSignal('version');
      case 'c': setCount(item.argument ?? '', 'bytes'); break;
      case 'n': setCount(item.argument ?? '', 'lines'); break;
      case 'f': {
        const mode = item.argument;
        if (mode === undefined) { opts.follow = 'descriptor'; break; }
        const matches = ['descriptor', 'name'].filter((name) => name.startsWith(mode));
        if (mode === '' || matches.length !== 1) {
          throw new TailArgsError(`invalid argument ${quoteLocale(mode)} for ${quoteLocale('--follow')}\nValid arguments are:\n  - ${quoteLocale('descriptor')}\n  - ${quoteLocale('name')}`, true);
        }
        opts.follow = matches[0] === 'name' ? 'name' : 'descriptor';
        break;
      }
      case 'F': opts.follow = 'name'; opts.retry = true; break;
      case 'R': opts.retry = true; break;
      case 'q': opts.quiet = true; opts.verbose = false; break;
      case 'v': opts.verbose = true; opts.quiet = false; break;
      case 'z': opts.zeroTerminated = true; break;
      case 's': {
        const seconds = Number(item.argument);
        if (item.argument === '' || !Number.isFinite(seconds) || seconds < 0) throw new TailArgsError(`invalid number of seconds: ${quoteLocale(item.argument ?? '')}`);
        opts.sleepIntervalSeconds = seconds;
        break;
      }
      case 'P': {
        if (!/^\d+$/.test(item.argument ?? '')) throw new TailArgsError(`invalid PID: ${quoteLocale(item.argument ?? '')}`);
        opts.pid = Number(item.argument);
        break;
      }
      case 'M': {
        if (!/^\d+$/.test(item.argument ?? '')) throw new TailArgsError(`invalid maximum number of unchanged stats between opens: ${quoteLocale(item.argument ?? '')}`);
        opts.maxUnchangedStats = Number(item.argument);
        break;
      }
      default: break;
    }
  }
  return opts;
}

/**
 * Stateless engine for slicing a string into the tail-portion implied by
 * `opts`. Exported standalone so unit tests can drive it without mocking
 * a VFS.
 */
export function sliceTail(content: string, opts: TailOptions): string {
  const sep = opts.zeroTerminated ? '\0' : '\n';
  if (opts.unit === 'bytes') {
    if (opts.fromStart) return takeBytes(content, Math.max(0, utf8Bytes(content) - Math.max(0, opts.count - 1)), true);
    return opts.count <= 0 ? '' : takeBytes(content, opts.count, true);
  }
  const parts = content.split(sep);
  const trailingNewline = parts.length > 0 && parts[parts.length - 1] === '';
  if (trailingNewline) parts.pop();
  const sliced = opts.fromStart
    ? parts.slice(Math.max(0, opts.count - 1))
    : opts.count <= 0 ? [] : parts.slice(-opts.count);
  if (sliced.length === 0) return '';
  const joined = sliced.join(sep);
  return trailingNewline ? joined + sep : joined;
}

/**
 * Format the `==> path <==` block separator. Real tail emits it on the
 * first file and whenever the active file changes; we expose the helper
 * for both the snapshot and the follow paths.
 */
export function tailHeader(path: string): string {
  return `==> ${path} <==`;
}

/**
 * `TailCommand` — instantiate once per dispatcher; the same instance can
 * service many `runOnce` / `startFollow` invocations.
 */
export class TailCommand {
  constructor(private readonly fs: TailFs) {}

  /**
   * Snapshot mode. Returns the formatted output with the canonical exit
   * code (0 on full success, 1 when at least one file could not be read).
   */
  runOnce(opts: TailOptions, cwd: string, stdin?: string): TailSnapshot {
    const streams = new Streams();
    const names = opts.files.length === 0 ? ['-'] : opts.files;
    const showHeaders = opts.verbose || (!opts.quiet && names.length > 1);
    let first = true;
    for (const f of names) {
      const label = f === '-' ? 'standard input' : f;
      let content: string | null;
      if (f === '-') content = stdin ?? '';
      else {
        const abs = this.fs.normalizePath(f, cwd);
        content = this.fs.readFile(abs);
        if (content === null && this.fs.isDirectory?.(abs) === true) {
          if (showHeaders) streams.stdout(`${first ? '' : '\n'}${tailHeader(label)}\n`);
          first = false;
          streams.diagnostic(`tail: error reading ${quoteShell(f)}: Is a directory`);
          streams.exitCode = 1;
          continue;
        }
        if (content === null) {
          streams.diagnostic(`tail: cannot open ${quoteShell(f)} for reading: No such file or directory`);
          streams.exitCode = 1;
          continue;
        }
      }
      if (showHeaders) streams.stdout(`${first ? '' : '\n'}${tailHeader(label)}\n`);
      first = false;
      streams.stdout(sliceTail(content, opts));
    }
    const run = streams.result();
    return run.stderr === ''
      ? { output: run.stdout, exitCode: run.exitCode }
      : { output: run.stdout, exitCode: run.exitCode, stderr: run.stderr, interleaved: run.interleaved };
  }

  /**
   * Start a follow-mode stream. Each followed file gets its own VFS
   * subscription; on every write event the appended slice is forwarded
   * to `sink.write()`. The initial snapshot (last N lines per file) is
   * also pushed through the sink so the caller's UI sees a single,
   * uniform append-only stream.
   */
  startFollow(opts: TailOptions, cwd: string, sink: TailSink): TailFollowHandle {
    if (opts.files.length === 0) {
      sink.error?.('tail: warning: following standard input indefinitely is ineffective');
      return inertHandle([]);
    }
    const showHeaders = opts.verbose || (!opts.quiet && opts.files.length > 1);
    const tracked = new Map<string, { abs: string; lastContent: string }>();
    const unsubs: Array<() => void> = [];
    let activeFile: string | null = null;

    const emitForFile = (display: string, abs: string, content: string, previous: string) => {
      const tracker = tracked.get(display);
      if (!tracker) return;
      const appended = computeAppended(previous, content);
      if (appended === null) {
        sink.warn?.(`tail: ${display}: file truncated`);
        tracker.lastContent = content;
        return;
      }
      if (appended.length === 0) return;
      if (showHeaders && activeFile !== display) {
        sink.write(`\n${tailHeader(display)}\n`);
        activeFile = display;
      } else if (activeFile === null) {
        activeFile = display;
      }
      sink.write(appended);
      tracker.lastContent = content;
    };

    // Seed phase: emit each file's tail-N before subscribing so the live
    // stream picks up exactly where the snapshot leaves off.
    for (let i = 0; i < opts.files.length; i++) {
      const display = opts.files[i];
      const abs = this.fs.normalizePath(display, cwd);
      const initial = this.fs.readFile(abs);
      if (initial === null) {
        if (opts.retry) {
          sink.warn?.(`tail: cannot open '${display}' for reading: No such file or directory`);
          tracked.set(display, { abs, lastContent: '' });
        } else {
          sink.error?.(`tail: cannot open '${display}' for reading: No such file or directory`);
          continue;
        }
      } else {
        tracked.set(display, { abs, lastContent: initial });
        const slice = sliceTail(initial, opts);
        if (showHeaders) {
          if (i > 0 && activeFile !== null) sink.write('\n');
          sink.write(`${tailHeader(display)}\n`);
          activeFile = display;
        }
        if (slice !== '') sink.write(slice.endsWith('\n') ? slice : slice + '\n');
      }
    }

    // Subscribe phase.
    for (const [display, tracker] of tracked) {
      const unsub = this.fs.onWrite(tracker.abs, (event) => {
        emitForFile(display, tracker.abs, event.current, tracker.lastContent);
      });
      unsubs.push(unsub);
    }

    let active = true;
    const handle: TailFollowHandle = {
      get active() { return active; },
      get files() { return Array.from(tracked.keys()); },
      cancel() {
        if (!active) return;
        active = false;
        for (const u of unsubs) u();
        unsubs.length = 0;
      },
    };
    return handle;
  }
}

/**
 * Diff helper: when `current` is a strict extension of `previous`, return
 * the appended suffix; otherwise (`current` shorter, or divergent) return
 * `null` to signal a truncation/rotation that the caller should report.
 */
function computeAppended(previous: string, current: string): string | null {
  if (current.length < previous.length) return null;
  if (current.startsWith(previous)) return current.slice(previous.length);
  return null;
}

function inertHandle(files: ReadonlyArray<string>): TailFollowHandle {
  let active = true;
  return {
    get active() { return active; },
    get files() { return files; },
    cancel() { active = false; },
  };
}

/**
 * Drive the full argv → result pipeline. Returns either a snapshot (when
 * `-f`/`-F` is absent) or a `kind: 'follow'` descriptor that the caller
 * must complete by supplying a sink — done via `attach()`.
 */
export type TailRunResult =
  | { kind: 'snapshot'; output: string; exitCode: number; stderr?: string; interleaved?: string }
  | {
      kind: 'follow';
      options: TailOptions;
      attach(sink: TailSink): TailFollowHandle;
      /** Snapshot rendering, used when callers want to seed the UI first. */
      preflight(): TailSnapshot;
    };

export function runTail(
  fs: TailFs,
  cwd: string,
  argv: readonly string[],
  stdin?: string,
): TailRunResult {
  let opts: TailOptions;
  try { opts = parseTailArgs(argv); }
  catch (e) {
    if (e instanceof TailDocsSignal) {
      const docs = docsResult('tail', e.which);
      return { kind: 'snapshot', output: docs.stdout, exitCode: 0 };
    }
    if (!(e instanceof TailArgsError)) throw e;
    const diagnostic = `tail: ${e.message}\n${e.usage ? "Try 'tail --help' for more information.\n" : ''}`;
    return { kind: 'snapshot', output: '', exitCode: 1, stderr: diagnostic, interleaved: diagnostic };
  }
  const cmd = new TailCommand(fs);
  if (opts.follow === 'none') {
    return { kind: 'snapshot', ...cmd.runOnce(opts, cwd, stdin) };
  }
  return {
    kind: 'follow',
    options: opts,
    preflight: () => cmd.runOnce(opts, cwd, stdin),
    attach: (sink) => cmd.startFollow(opts, cwd, sink),
  };
}
