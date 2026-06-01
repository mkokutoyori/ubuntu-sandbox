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

import type { VirtualFileSystem, VfsWriteEvent } from '../VirtualFileSystem';

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

class TailArgsError extends Error {}

/**
 * Parse the argv that follows `tail` into a structured `TailOptions`.
 * Supports clustered short flags (`-fn5`), `-n+5`, `--lines=+5`, and the
 * historical `-N` (e.g. `-50`).
 */
export function parseTailArgs(argv: readonly string[]): TailOptions {
  const opts: TailOptions = { ...DEFAULT_OPTIONS, files: [] };
  let i = 0;
  const setCount = (raw: string, unit: 'lines' | 'bytes') => {
    const m = /^([+-]?)(\d+)([bkKMG]?)$/.exec(raw);
    if (!m) throw new TailArgsError(`invalid number of ${unit}: '${raw}'`);
    const sign = m[1];
    let n = Number.parseInt(m[2], 10);
    const mult: Record<string, number> = { '': 1, b: 512, k: 1024, K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 };
    n *= mult[m[3]] ?? 1;
    opts.count = n;
    opts.unit = unit;
    opts.fromStart = sign === '+';
  };
  const take = (flag: string): string => {
    const v = argv[++i];
    if (v === undefined) throw new TailArgsError(`option requires an argument -- '${flag}'`);
    return v;
  };
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { for (let j = i + 1; j < argv.length; j++) opts.files.push(argv[j]); break; }
    if (a === '-f') { opts.follow = 'descriptor'; i++; continue; }
    if (a === '-F') { opts.follow = 'name'; opts.retry = true; i++; continue; }
    if (a === '--follow') { opts.follow = 'descriptor'; i++; continue; }
    if (a.startsWith('--follow=')) {
      opts.follow = a.slice('--follow='.length) === 'name' ? 'name' : 'descriptor';
      i++; continue;
    }
    if (a === '-n') { setCount(take('n'), 'lines');  i++; continue; }
    if (a === '-c') { setCount(take('c'), 'bytes');  i++; continue; }
    if (a.startsWith('--lines='))  { setCount(a.slice('--lines='.length), 'lines'); i++; continue; }
    if (a.startsWith('--bytes='))  { setCount(a.slice('--bytes='.length), 'bytes'); i++; continue; }
    if (a === '-q' || a === '--quiet' || a === '--silent')  { opts.quiet = true; i++; continue; }
    if (a === '-v' || a === '--verbose')                    { opts.verbose = true; i++; continue; }
    if (a === '-z' || a === '--zero-terminated')            { opts.zeroTerminated = true; i++; continue; }
    if (a === '--retry')                                    { opts.retry = true; i++; continue; }
    if (a === '-s' || a === '--sleep-interval')             { opts.sleepIntervalSeconds = Number.parseFloat(take('s')) || 1; i++; continue; }
    if (a.startsWith('--sleep-interval='))                  { opts.sleepIntervalSeconds = Number.parseFloat(a.slice('--sleep-interval='.length)) || 1; i++; continue; }
    if (a.startsWith('--pid='))                             { opts.pid = Number.parseInt(a.slice('--pid='.length), 10); i++; continue; }
    if (a.startsWith('--max-unchanged-stats='))             { opts.maxUnchangedStats = Number.parseInt(a.slice('--max-unchanged-stats='.length), 10); i++; continue; }
    // Historical `-50` and `+50` line counts.
    if (/^-\d+$/.test(a)) { setCount(a.slice(1), 'lines'); i++; continue; }
    if (/^\+\d+$/.test(a)) { setCount(a, 'lines'); i++; continue; }
    // Clustered flags like `-fn5`.
    if (/^-[a-zA-Z]+/.test(a) && a.length > 2) {
      const cluster = a.slice(1);
      let consumed = false;
      for (let k = 0; k < cluster.length; k++) {
        const ch = cluster[k];
        if (ch === 'f') opts.follow = opts.follow === 'none' ? 'descriptor' : opts.follow;
        else if (ch === 'F') { opts.follow = 'name'; opts.retry = true; }
        else if (ch === 'q') opts.quiet = true;
        else if (ch === 'v') opts.verbose = true;
        else if (ch === 'n' || ch === 'c') {
          const rest = cluster.slice(k + 1);
          const value = rest.length > 0 ? rest : take(ch);
          setCount(value, ch === 'n' ? 'lines' : 'bytes');
          consumed = true;
          break;
        }
        else throw new TailArgsError(`invalid option -- '${ch}'`);
      }
      i++; if (consumed) continue; continue;
    }
    if (a.startsWith('-') && a.length > 1) throw new TailArgsError(`unrecognized option '${a}'`);
    opts.files.push(a);
    i++;
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
    if (opts.fromStart) return content.slice(Math.max(0, opts.count - 1));
    return opts.count <= 0 ? '' : content.slice(-opts.count);
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
    if (opts.files.length === 0) {
      const body = stdin === undefined ? '' : sliceTail(stdin, opts);
      return { output: body, exitCode: 0 };
    }
    const parts: string[] = [];
    let exit = 0;
    const showHeaders = opts.verbose || (!opts.quiet && opts.files.length > 1);
    for (let i = 0; i < opts.files.length; i++) {
      const f = opts.files[i];
      const abs = this.fs.normalizePath(f, cwd);
      const content = this.fs.readFile(abs);
      if (content === null) {
        parts.push(`tail: cannot open '${f}' for reading: No such file or directory`);
        exit = 1;
        continue;
      }
      if (showHeaders) {
        if (i > 0) parts.push('');
        parts.push(tailHeader(f));
      }
      const body = sliceTail(content, opts);
      if (body !== '') parts.push(body.replace(/\n$/, ''));
    }
    return { output: parts.join('\n'), exitCode: exit };
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
  | { kind: 'snapshot'; output: string; exitCode: number }
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
    const msg = e instanceof TailArgsError ? `tail: ${e.message}` : 'tail: invalid argument';
    return { kind: 'snapshot', output: msg, exitCode: 1 };
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
