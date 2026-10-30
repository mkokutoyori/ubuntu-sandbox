/**
 * BashInterpreter — Walks the AST and executes bash commands.
 *
 * Orchestrates: Environment, Expansion, Builtins, and external command delegation.
 *
 * The evaluation core is a sans-IO generator: visitors never call the
 * external-command callback directly, they `yield` an {@link ExternalRequest}
 * and receive the result back from the driver. Two drivers exist —
 * {@link BashInterpreter.execute} (synchronous, the historical API) and
 * {@link BashInterpreter.executeAsync} (awaits Promise-returning externals,
 * e.g. network commands that traverse the simulated wire).
 *
 * Command substitutions inside word expansion are resolved through a
 * replay-with-memoization bridge (`withSubstitutions`): the synchronous
 * expansion code runs against memoized results; when it hits a not-yet-run
 * substitution it aborts with {@link NeedSubcommand}, the generator core
 * evaluates that subcommand (possibly awaiting externals) and the expansion
 * is replayed. Each unique occurrence executes exactly once.
 */

import type {
  Program, CommandList, AndOrList, Pipeline, Command,
  SimpleCommand, IfClause, ForClause, WhileClause, UntilClause,
  CaseClause, FunctionDef, BraceGroup, Subshell,
  DoubleBracket, DBExpr, ArithmeticCommand, CStyleForClause,
  Word, Assignment, Redirection,
} from '@/bash/parser/ASTNode';
import type { SyntaxFailure } from '@/bash/parser/SyntaxFailure';
import { parseScript } from '@/bash/parser/ParseScript';
import { Environment } from '@/bash/runtime/Environment';
import { initializeShellOptions, isShellOptionEnabled, optionFlags } from '@/bash/runtime/ShellOptions';
import { signalName, signalNumber, terminatesByDefault } from '@/bash/runtime/Signals';
import { expandWord, expandWords, expandPattern, expandText, BashRuntimeError, evaluateArithmetic } from '@/bash/runtime/Expansion';
import type { GlobFn, HomeForFn } from '@/bash/runtime/Expansion';
import {
  ArithmeticError, ExitSignal, ReturnSignal, BreakSignal, ContinueSignal, DaemonParkSignal,
} from '@/bash/errors/BashError';
import { backgroundGroupText } from './CommandText';
import { yieldWhenSliceIsSpent } from '@/events/CooperativeYield';
import { isBuiltin, isShellBuiltinName, executeBuiltin } from '@/bash/runtime/Builtins';
import { parseDeclarationFlags } from '@/bash/runtime/Declare';
import type { DeclarationCommand } from '@/bash/runtime/Declare';
import { RedirectWriteError } from './RedirectWriteError';
import { OutputLog } from '@/bash/runtime/OutputLog';
import type { Newline } from '@/bash/runtime/OutputLog';
import { StdinSource } from '@/bash/runtime/StdinSource';
import { fnmatch } from '@/network/devices/linux/fs/Glob';
import { AliasTable } from '@/bash/runtime/AliasTable';
import { BashLexer } from '@/bash/lexer/BashLexer';
import { BashParser } from '@/bash/parser/BashParser';
import { LexerError } from '@/bash/lexer/LexerError';
import { ParserError } from '@/bash/parser/ParserError';

/** Result from executing an external command. */
export interface ExternalCommandResult {
  output: string;
  exitCode: number;
  /**
   * Optional pure stderr stream. When present, `output` is the command's
   * stdout (fd 1) and `stderr` its fd 2 — letting the shell route them to
   * separate redirections. When absent, the legacy model applies (the
   * whole `output` is treated as stderr iff the exit code is non-zero).
   */
  stderr?: string;
  interleaved?: string;
  chunks?: ReadonlyArray<{ readonly fd: 1 | 2; readonly text: string }>;
  backgroundPid?: number;
  lineOriented?: boolean;
}

/**
 * Callback type for executing external (non-builtin) commands.
 *
 * `env` carries a snapshot of the shell environment at dispatch time
 * (exported variables plus any per-command `VAR=val` prefix assignments)
 * so external commands such as `ssh` can honour environment forwarding.
 *
 * A Promise return is only honoured by the async driver
 * ({@link BashInterpreter.executeAsync}); the sync driver rejects it.
 */
export type ExternalCommandFn = (
  argv: string[],
  env?: Record<string, string>,
  background?: boolean,
  outputPiped?: boolean,
  stdin?: string,
) => ExternalCommandResult | string | Promise<ExternalCommandResult | string>;

/** A request the evaluation core yields to its driver. */
export interface ExternalRequest {
  argv: string[];
  env?: Record<string, string>;
  background?: boolean;
  /**
   * True when this command's stdout is not a terminal — it feeds a later
   * pipeline stage, or is redirected to a file (`>`/`>>`). Real coreutils
   * (`ls`, …) call `isatty(STDOUT_FILENO)` and change their formatting
   * accordingly (e.g. `ls` drops multi-column layout); this is that
   * signal, computed here since only the interpreter walks the
   * Pipeline/Redirection AST.
   */
  outputPiped?: boolean;
  /**
   * The content on this command's standard input — from a pipe, a `<`
   * redirection or a herestring — or `undefined` when stdin is the
   * terminal.
   *
   * It is *also* appended to `argv` as a trailing word, which is how every
   * consumer has read it so far and stays the case here. That convention
   * cannot express the difference between `cmd file` and `printf x | cmd`,
   * since both arrive as one trailing word; this field can, and is what a
   * driver should read when it needs to tell them apart.
   */
  stdin?: string;
}

/** The sans-IO evaluation type: yields external requests, receives results. */
type Effects<T> = Generator<ExternalRequest, T, ExternalCommandResult>;

/** Normalize an external command result to the standard format. */
function normalizeResult(result: ExternalCommandResult | string): ExternalCommandResult {
  if (typeof result === 'string') return { output: result, exitCode: 0 };
  return result;
}

function ensureTrailingNewline(s: string): string {
  return s.length === 0 || s.endsWith('\n') ? s : s + '\n';
}

function terminalText(output: string, lineOriented: boolean | undefined): string {
  return lineOriented === false ? output : ensureTrailingNewline(output);
}

/** IO context for file redirections. */
export interface IOContext {
  writeFile(path: string, content: string, append: boolean): void;
  readFile(path: string): string | null;
  /** Resolve a path relative to cwd. */
  resolvePath(path: string, cwd?: string): string;
  /** Check if a path exists and its type. Returns null if not found. */
  stat?(path: string): { type: 'file' | 'directory' } | null;
  /**
   * Expand a shell glob (`*`, `?`, `[…]`) against the live filesystem.
   * Returns the matched paths, or `null` to indicate the host could not
   * resolve the pattern (the interpreter then falls back to the literal,
   * matching bash's `nullglob`-off default).
   */
  globExpand?(pattern: string, cwd: string, options?: { dotglob?: boolean; nocaseglob?: boolean; globstar?: boolean }): string[] | null;
  /** Resolve the home directory of `user`; `null` means the user is unknown. */
  homeFor?(user: string): string | null;
  wallClock?(): { nowMs(): number; format(pattern: string, epochMs: number): string };
  /**
   * A backgrounded command keeps writing to its stdout after the shell has
   * moved on (`nc -l > file &` receives data minutes later): the shell binds
   * the file to the job's pid once the redirection is applied.
   */
  getUmask?(): number;
  setUmask?(mask: number): void;
  bindBackgroundStdout?(pid: number, path: string): void;
  bindBackgroundStderr?(pid: number, path: string, append: boolean): void;
  holdBackgroundStdin?(pid: number, path: string): void;
  beginBackgroundSubshell?(label: string): number;
  endBackgroundSubshell?(pid: number, outcome: { cwd: string; image: readonly string[] | null; output: string; exitCode: number; parked: boolean }): void;
  backgroundAnnouncement?(pid: number): string | null;
  ignoresStdin?(argv: readonly string[]): boolean;
}

type Sink =
  | { readonly kind: 'out' }
  | { readonly kind: 'err' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'file'; readonly path: string };

interface RedirectPlan {
  stdin?: string;
  readonly sinks: Map<number, Sink>;
  failed: boolean;
  stdoutRedirected: boolean;
}

export interface InterpreterOptions {
  /** Execute an external command (e.g., ls, cat). Returns stdout. */
  executeCommand: ExternalCommandFn;
  /** Initial environment variables. */
  variables?: Record<string, string>;
  /** Script name ($0). */
  scriptName?: string;
  /** Positional args ($1, $2, ...). */
  positionalArgs?: string[];
  /** IO context for file redirections. Optional — if missing, redirections are ignored. */
  io?: IOContext;
  /** Shell PID ($$). */
  pid?: number;
  /** Parent PID ($PPID). */
  ppid?: number;
  /** Initial `$?` carried from the previous command. */
  initialExitCode?: number;
  /**
   * Shared alias table. When provided, the interpreter mutates it in
   * place so `alias` / `unalias` definitions persist across commands.
   */
  aliases?: AliasTable;
  functions?: Map<string, Command>;
  /** True for a backgrounded job — makes unconditional loops (`while
   *  true`) run their body once, then park via {@link DaemonParkSignal}. */
  daemonMode?: boolean;
  stdin?: string;
  /** True for a shell reading commands from a terminal (aliases expand). */
  interactive?: boolean;
}

/**
 * Raised by the memoized substitution lookup when synchronous expansion
 * hits a command substitution whose result has not been computed yet.
 * The generator core catches it, evaluates the subcommand, memoizes the
 * result and replays the expansion.
 */
class NeedSubcommand {
  constructor(readonly command: string) {}
}

/**
 * Memoized command-substitution results, keyed by command text with
 * per-replay occurrence counters so `$(cmd)` appearing twice in one word
 * gets two independent evaluations, in order.
 */
class SubstitutionMemo {
  private readonly results = new Map<string, string[]>();
  private counters = new Map<string, number>();

  beginReplay(): void {
    this.counters = new Map();
  }

  lookup(command: string): string | undefined {
    const occurrence = this.counters.get(command) ?? 0;
    this.counters.set(command, occurrence + 1);
    return this.results.get(command)?.[occurrence];
  }

  store(command: string, value: string): void {
    const list = this.results.get(command);
    if (list) list.push(value);
    else this.results.set(command, [value]);
  }
}

export class BashInterpreter {
  env: Environment;
  private executeCommand: ExternalCommandFn;
  private io: IOContext | null;
  private log = new OutputLog();
  /** Set by a bare `exec >> file 2>> errfile` — see runProgram. */
  private execRedirect: { stdout?: { path: string; append: boolean; pipe?: string }; stderr?: { path: string; append: boolean }; mergeStderr?: boolean; from: number } | null = null;
  private stdin: StdinSource | null = null;
  private readonly fdOutputs = new Map<number, Sink>();
  private readonly fdInputs = new Map<number, StdinSource>();
  private lastSubstitutionStatus: number | null = null;
  private currentLine = 1;
  private statusFromGuard = false;
  /**
   * True while running any stage of a pipeline *except the last* — see
   * `runPipelineStages`: its stdout feeds a pipe, not the terminal.
   */
  private nonLastPipelineStage = false;
  private functions: Map<string, Command>;
  /** Command aliases — shared with the owning shell when one is passed. */
  readonly aliases: AliasTable;
  private readonly daemonMode: boolean;
  private readonly interactive: boolean;
  private functionStack: string[] = [];
  private callerLines: number[] = [];
  private readonly jobs = new Map<string, number>();
  private jobCounter = 0;

  constructor(options: InterpreterOptions) {
    this.executeCommand = options.executeCommand;
    this.io = options.io ?? null;
    this.aliases = options.aliases ?? new AliasTable();
    this.functions = options.functions ?? new Map();
    this.daemonMode = options.daemonMode ?? false;
    this.interactive = options.interactive ?? false;
    if (options.stdin !== undefined) this.stdin = new StdinSource(options.stdin);
    const now = (): number => this.io?.wallClock?.().nowMs() ?? Date.now();
    const startedAt = now();
    this.env = new Environment({
      dynamicVariables: {
        RANDOM: () => String(Math.floor(Math.random() * 32768)),
        SECONDS: () => String(Math.floor((now() - startedAt) / 1000)),
        EPOCHSECONDS: () => String(Math.floor(now() / 1000)),
        EPOCHREALTIME: () => (now() / 1000).toFixed(6),
        LINENO: () => String(this.currentLine),
        '-': () => optionFlags(this.env, this.interactive),
      },
      variables: options.variables,
      scriptName: options.scriptName ?? 'bash',
      positionalArgs: options.positionalArgs,
      pid: options.pid,
      ppid: options.ppid,
      initialExitCode: options.initialExitCode,
    });
    initializeShellOptions(this.env, this.interactive);
    this.publishCallFrames(this.env);
  }

  private publishCallFrames(target: Environment): void {
    const script = this.env.get('0') ?? 'bash';
    const scriptMode = script !== 'bash';
    const depth = this.functionStack.length;
    if (depth === 0) {
      target.unset('FUNCNAME');
      if (scriptMode) {
        target.setArray('BASH_SOURCE', [script]);
        target.setArray('BASH_LINENO', ['0']);
      }
      return;
    }
    target.setArray('FUNCNAME', [...this.functionStack, ...(scriptMode ? ['main'] : [])]);
    target.setArray('BASH_LINENO', [...this.callerLines.map(String), ...(scriptMode ? ['0'] : [])]);
    target.setArray('BASH_SOURCE', scriptMode ? Array(depth + 1).fill(script) : Array(depth).fill('environment'));
  }

  // ─── Public API ───────────────────────────────────────────────

  /** Execute a Program AST synchronously. External commands must be sync. */
  execute(program: Program): { output: string; exitCode: number; stderr: string } {
    return this.driveSync(this.runProgram(program));
  }

  /**
   * Execute a Program AST, awaiting Promise-returning external commands.
   * Semantically identical to {@link execute} for synchronous externals.
   */
  executeAsync(program: Program): Promise<{ output: string; exitCode: number; stderr: string }> {
    return this.driveAsync(this.runProgram(program));
  }

  /**
   * Execute a command string for command substitution ($(...)).
   * Parses and runs through the full interpreter pipeline in the current env.
   */
  executeSubcommand(cmd: string): string {
    return this.driveSync(this.subcommandG(cmd));
  }

  getTrap(signal: string): string | undefined {
    return this.env.getTrap(signal);
  }

  /** Run a `trap` handler against this interpreter's live env — how a
   *  POSIX signal reaches a parked background job. Returns whether the
   *  handler called `exit` (only then should the caller terminate). */
  runInterrupt(signalHandlerBody: string): { output: string; exited: boolean; exitCode: number } {
    const savedLog = this.log;
    this.log = new OutputLog();
    let exited = false;
    let exitCode = this.env.lastExitCode;
    try {
      this.driveSync(this.executeEvalG(signalHandlerBody));
    } catch (e) {
      if (e instanceof ExitSignal) {
        exited = true;
        exitCode = e.exitCode;
        this.env.lastExitCode = exitCode;
        this.driveSync(this.fireExitTrap()); // exit always fires EXIT, even mid-signal-handler
      } else {
        throw e;
      }
    }
    const out = this.log.terminal();
    this.log = savedLog;
    return { output: out, exited, exitCode };
  }

  // ─── Drivers ──────────────────────────────────────────────────

  private driveSync<T>(gen: Effects<T>): T {
    let step = gen.next();
    while (step.done !== true) {
      let feed: ExternalCommandResult;
      try {
        const raw = this.executeCommand(
          step.value.argv, step.value.env, step.value.background, step.value.outputPiped,
          step.value.stdin);
        if (raw instanceof Promise) {
          feed = {
            output: `bash: ${step.value.argv[0]}: cannot run an asynchronous command in a synchronous shell\n`,
            exitCode: 1,
          };
        } else {
          feed = normalizeResult(raw);
        }
      } catch (e) {
        if (e instanceof ExitSignal || e instanceof DaemonParkSignal) {
          step = gen.throw(e);
          continue;
        }
        feed = { output: '', exitCode: 127 };
      }
      step = gen.next(feed);
    }
    return step.value;
  }

  private async driveAsync<T>(gen: Effects<T>): Promise<T> {
    let step = gen.next();
    while (step.done !== true) {
      let feed: ExternalCommandResult;
      try {
        feed = normalizeResult(await this.executeCommand(
          step.value.argv, step.value.env, step.value.background, step.value.outputPiped,
          step.value.stdin));
        await yieldWhenSliceIsSpent();
      } catch (e) {
        if (e instanceof ExitSignal || e instanceof DaemonParkSignal) {
          step = gen.throw(e);
          continue;
        }
        feed = { output: '', exitCode: 127 };
      }
      step = gen.next(feed);
    }
    return step.value;
  }

  private *runProgram(program: Program): Effects<{ output: string; exitCode: number; stderr: string }> {
    this.log = new OutputLog();
    try {
      yield* this.visitTopLevel(program.body, program.warnings);
      if (program.syntaxFailure !== undefined) this.reportSyntaxFailure(program.syntaxFailure, this.syntaxLabel());
    } catch (e) {
      if (e instanceof ExitSignal) {
        this.env.lastExitCode = e.exitCode;
      } else if (e instanceof BashRuntimeError || e instanceof ArithmeticError) {
        this.emitError(`bash: ${e.message}`);
        this.env.lastExitCode = 1;
      } else if (e instanceof DaemonParkSignal) {
        throw e; // parked, not exiting — no EXIT trap
      } else {
        yield* this.fireExitTrap();
        throw e;
      }
    }
    yield* this.fireExitTrap();
    const stderr = this.log.stream(2);
    if (this.execRedirect && this.io) {
      const { before, after } = this.log.split(this.execRedirect.from);
      const excluded = new Set<1 | 2>();
      let piped = '';
      if (this.execRedirect.stdout) {
        const { path, append, pipe } = this.execRedirect.stdout;
        const written = this.execRedirect.mergeStderr
          ? after.entries().map((chunk) => (chunk.newline === 'never' ? chunk.text : ensureTrailingNewline(chunk.text))).join('')
          : after.stream(1);
        this.io.writeFile(path, written, append);
        excluded.add(1);
        if (this.execRedirect.mergeStderr) excluded.add(2);
        if (pipe !== undefined) piped = yield* this.subcommandG(`${pipe} < ${path}`);
      }
      if (this.execRedirect.stderr) {
        this.io.writeFile(this.execRedirect.stderr.path, after.stream(2), this.execRedirect.stderr.append);
        excluded.add(2);
      }
      const remaining = excluded.has(2) ? before.stream(2) : stderr;
      return { output: before.terminal() + after.terminal(excluded) + piped, exitCode: this.env.lastExitCode, stderr: remaining };
    }
    return { output: this.log.terminal(), exitCode: this.env.lastExitCode, stderr };
  }

  // ─── Expansion bridge (replay with memoization) ───────────────

  private *withSubstitutions<T>(run: (cmdExec: (cmd: string) => string) => T): Effects<T> {
    const memo = new SubstitutionMemo();
    const cmdExec = (cmd: string): string => {
      const hit = memo.lookup(cmd);
      if (hit === undefined) throw new NeedSubcommand(cmd);
      return hit;
    };
    for (;;) {
      memo.beginReplay();
      try {
        return run(cmdExec);
      } catch (e) {
        if (!(e instanceof NeedSubcommand)) throw e;
        memo.store(e.command, yield* this.subcommandG(e.command));
      }
    }
  }

  private *expandWordG(word: Word): Effects<string> {
    return yield* this.withSubstitutions(
      (cmdExec) => expandWord(word, this.env, cmdExec, this.homeFor()),
    );
  }

  private *expandTextG(text: string): Effects<string> {
    return yield* this.withSubstitutions(
      (cmdExec) => expandText(text, this.env, cmdExec, this.homeFor()),
    );
  }

  private *expandPatternG(word: Word): Effects<string> {
    return yield* this.withSubstitutions(
      (cmdExec) => expandPattern(word, this.env, cmdExec, this.homeFor()),
    );
  }

  private *expandWordsG(words: Word[]): Effects<string[]> {
    return yield* this.withSubstitutions(
      (cmdExec) => expandWords(words, this.env, cmdExec, this.makeGlobFn(), this.homeFor()),
    );
  }

  private *subcommandG(cmd: string): Effects<string> {
    const fileOnly = cmd.trim().match(/^<\s*(\S+)$/);
    if (fileOnly && this.io) {
      const path = this.absolutePath(fileOnly[1]);
      const content = this.io.readFile(path);
      if (content !== null) {
        this.lastSubstitutionStatus = 0;
        return content;
      }
      this.emitError(`bash: ${fileOnly[1]}: No such file or directory`);
      this.lastSubstitutionStatus = 1;
      return '';
    }
    const outer = this.log;
    const inner = new OutputLog();
    const savedEnv = this.env;
    const savedUmask = this.captureUmask();
    let status = 0;
    try {
      const lexer = new BashLexer();
      const parser = new BashParser();
      const tokens = lexer.tokenize(cmd, true, this.currentLine);
      const ast = parser.parse(tokens);
      this.log = inner;
      this.env = savedEnv.createSubshell();
      try {
        yield* this.visitCommandList(ast.body);
        status = this.env.lastExitCode;
      } catch (e) {
        if (!(e instanceof ExitSignal)) throw e;
        status = e.exitCode;
      }
    } catch (e) {
      if (e instanceof BashRuntimeError || e instanceof ArithmeticError) {
        inner.write(2, `bash: ${e.message}\n`);
        status = 1;
      } else if (e instanceof LexerError || e instanceof ParserError) {
        const result = normalizeResult(yield { argv: cmd.split(/\s+/) });
        inner.write(1, result.output);
        status = result.exitCode;
      } else {
        throw e;
      }
    } finally {
      this.env = savedEnv;
      this.log = outer;
      this.restoreUmask(savedUmask);
    }
    this.forward(inner, outer, false);
    this.lastSubstitutionStatus = status;
    return inner.stream(1);
  }

  private forward(from: OutputLog, to: OutputLog, includeStdout: boolean): void {
    for (const chunk of from.entries()) {
      if (chunk.fd === 2 || includeStdout) to.write(chunk.fd, chunk.text, chunk.newline, chunk.ambiguous);
    }
  }

  private makeGlobFn(): GlobFn | undefined {
    if (!this.io?.globExpand) return undefined;
    const expand = this.io.globExpand.bind(this.io);
    return (pattern: string, options) => {
      const cwd = this.env.get('PWD') ?? '/';
      try { return expand(pattern, cwd, options); }
      catch { return null; }
    };
  }

  /** Tilde-expander bound to the host's user database (or null). */
  private homeFor(): HomeForFn | undefined {
    if (!this.io?.homeFor) return undefined;
    const lookup = this.io.homeFor.bind(this.io);
    return (user) => { try { return lookup(user); } catch { return null; } };
  }

  // ─── Traps ────────────────────────────────────────────────────

  /** Run the EXIT trap (if any), preserving the parent script's exit code. */
  private *fireExitTrap(): Effects<void> {
    const handler = this.env.getTrap('EXIT');
    if (!handler) return;
    this.env.clearTrap('EXIT');                              // prevent re-entry
    const savedExit = this.env.lastExitCode;
    try { yield* this.executeEvalG(handler, false, this.currentLine); } catch { /* swallow — trap must not abort cleanup */ }
    this.env.lastExitCode = savedExit;
  }

  // Re-entry guard so a trap handler cannot recursively re-fire its own signal.
  private inTrap = 0;

  private *fireSignalTrap(signal: 'ERR' | 'DEBUG' | 'RETURN'): Effects<void> {
    if (this.inTrap > 0) return;
    const handler = this.lookupTrapInherited(signal);
    if (!handler) return;
    const savedExit = this.env.lastExitCode;
    this.inTrap++;
    try { yield* this.executeEvalG(handler, false, this.currentLine); } catch { /* a broken trap must not crash the script */ }
    finally { this.inTrap--; this.env.lastExitCode = savedExit; }
  }

  // Traps set at script scope must fire from inside functions too
  // (equivalent of bash `set -E -T`).
  private lookupTrapInherited(signal: string): string | undefined {
    let cursor: Environment | null = this.env;
    while (cursor) {
      const h = cursor.getTrap(signal);
      if (h !== undefined) return h;
      cursor = cursor.getParent();
    }
    return undefined;
  }

  // ─── Visitors ─────────────────────────────────────────────────

  /** Counter for contexts that suppress `errexit` (if/while/until heads, &&/|| LHS, `!`). */
  private errexitSuppress = 0;

  /** True when `set -e` is active. */
  private isErrExit(): boolean {
    return isShellOptionEnabled(this.env, 'errexit');
  }
  /** True when `set -o pipefail` is active. */
  private isPipefail(): boolean {
    return isShellOptionEnabled(this.env, 'pipefail');
  }
  /** True when `set -u` (nounset) is active — consulted by expansion. */
  isNounset(): boolean {
    return isShellOptionEnabled(this.env, 'nounset');
  }

  private lastPipelineNegated = false;

  private syntaxLabel(): string {
    const name = this.env.get('0');
    return name === 'bash' ? 'bash: -c' : name ?? 'bash';
  }

  private reportSyntaxFailure(failure: SyntaxFailure, label: string): void {
    for (const diagnostic of failure.diagnostics) {
      this.log.write(2, `${label}: line ${diagnostic.line}: ${diagnostic.text}\n`, 'never');
    }
    this.env.lastExitCode = 2;
  }

  private isolatedStatus(e: unknown): number {
    if (e instanceof ExitSignal) return e.exitCode;
    if (!this.isLineAbort(e)) throw e;
    this.emitError(`bash: ${e.message.replace(/^bash: /, '')}`);
    return 1;
  }

  private isLineAbort(e: unknown): e is Error {
    if (e instanceof BashRuntimeError) return !e.fatal;
    if (e instanceof ArithmeticError) return true;
    return e instanceof Error && /^bash: .*: readonly variable$/.test(e.message);
  }

  private *visitTopLevel(node: CommandList, warnings: Program['warnings'] = []): Effects<void> {
    let abortedLine = 0;
    for (const [index, andOr] of node.commands.entries()) {
      const nextStart = node.commands[index + 1]?.position?.line ?? Infinity;
      for (const warning of warnings) {
        if (warning.line >= (andOr.position?.line ?? 0) && warning.line < nextStart) {
          this.log.write(2, `${this.syntaxLabel()}: line ${warning.reportedLine}: ${warning.text}\n`, 'never');
        }
      }
      if ((andOr.position?.line ?? Infinity) <= abortedLine) continue;
      try {
        yield* this.visitCommandList({ ...node, commands: [andOr] });
      } catch (e) {
        if (!this.isLineAbort(e)) throw e;
        this.emitError(`bash: ${e.message.replace(/^bash: /, '')}`);
        this.env.lastExitCode = 1;
        abortedLine = this.currentLine;
      }
    }
  }

  private *visitCommandList(node: CommandList): Effects<void> {
    for (const andOr of node.commands) {
      this.statusFromGuard = false;
      yield* this.visitAndOrList(andOr);
      if (this.errexitSuppress === 0 && this.isErrExit() && this.env.lastExitCode !== 0
          && !this.lastPipelineNegated && !this.statusFromGuard) {
        throw new ExitSignal(this.env.lastExitCode);
      }
    }
  }

  private readonly externalChildren = new Set<string>();
  private readonly aliasDefinedOnLine = new Map<string, number>();
  private loopDepth = 0;
  private sourceDepth = 0;

  private exitArgumentsValid(operands: string[]): boolean {
    if (!/^[+-]?\d+$/.test(operands[0])) {
      this.emitError(`bash: exit: ${operands[0]}: numeric argument required`);
      throw new ExitSignal(2);
    }
    if (operands.length > 1) {
      this.emitError('bash: exit: too many arguments');
      this.env.lastExitCode = 1;
      return false;
    }
    return true;
  }

  private lastLineOriented: boolean | undefined = undefined;
  private pendingBackground = false;
  private backgroundLastStage = false;
  private execImage: string[] | null = null;
  private daemonDepth = 0;

  private *visitAndOrList(node: AndOrList): Effects<void> {
    if (node.background && node.rest.length === 0
        && node.first.commands.length === 1 && !node.first.negated
        && node.first.commands[0].type === 'SimpleCommand') {
      this.pendingBackground = true;
      try {
        yield* this.visitPipeline(node.first);
      } finally {
        this.pendingBackground = false;
      }
      this.env.lastExitCode = 0;
      return;
    }
    if (node.background && node.rest.length === 0 && !node.first.negated
        && node.first.commands.length === 1
        && (node.first.commands[0].type === 'Subshell' || node.first.commands[0].type === 'BraceGroup')
        && this.io?.beginBackgroundSubshell !== undefined) {
      yield* this.runBackgroundGroup(node.first.commands[0]);
      this.env.lastExitCode = 0;
      return;
    }
    if (node.background && node.rest.length === 0 && !node.first.negated
        && node.first.commands.length > 1 && node.first.commands.every((command) => command.type === 'SimpleCommand')) {
      this.backgroundLastStage = true;
      try {
        yield* this.visitPipeline(node.first);
      } finally {
        this.backgroundLastStage = false;
        this.pendingBackground = false;
      }
      this.env.lastExitCode = 0;
      return;
    }
    if (node.background) {
      yield* this.runAsJob({ ...node, background: false });
      return;
    }
    // `set -e` is suppressed for every stage EXCEPT the last in an
    // and-or chain (bash semantics: `cmd1 && cmd2` aborts on cmd2's
    // failure, never on cmd1's, because cmd1 is itself a guard).
    const hasRest = node.rest.length > 0;
    let finalExecuted = !hasRest;
    if (hasRest) this.errexitSuppress++;
    try {
      yield* this.visitPipeline(node.first);
      for (let i = 0; i < node.rest.length; i++) {
        const part = node.rest[i];
        const isLast = i === node.rest.length - 1;
        if (part.operator === '&&' && this.env.lastExitCode !== 0) continue;
        if (part.operator === '||' && this.env.lastExitCode === 0) continue;
        if (isLast) this.errexitSuppress--;
        yield* this.visitPipeline(part.pipeline);
        if (isLast) { this.errexitSuppress++; finalExecuted = true; }
      }
    } finally {
      if (hasRest) this.errexitSuppress--;
    }
    this.statusFromGuard = !finalExecuted;
  }

  private *runAsJob(node: AndOrList): Effects<void> {
    this.jobCounter++;
    const pid = String(Number(this.env.get('$')) + this.jobCounter);
    const jobEnv = this.env.createSubshell();
    const shellEnv = this.env;
    this.env = jobEnv;
    let status = 0;
    try {
      yield* this.visitAndOrList(node);
      status = this.env.lastExitCode;
    } catch (e) {
      status = this.isolatedStatus(e);
    } finally {
      this.env = shellEnv;
    }
    this.jobs.set(pid, status);
    this.env.recordBackgroundPid(pid);
    this.env.lastExitCode = 0;
  }

  private waitForJobs(operands: string[]): boolean {
    if (operands.length === 0) {
      this.jobs.clear();
      this.env.lastExitCode = 0;
      return true;
    }
    if (operands.every((operand) => this.externalChildren.has(operand))) return false;
    let status = 0;
    for (const operand of operands) {
      const known = this.jobs.get(operand);
      if (known !== undefined) {
        status = known;
        this.jobs.delete(operand);
      } else if (/^\d+$/.test(operand)) {
        this.emitError(`bash: wait: pid ${operand} is not a child of this shell`);
        status = 127;
      } else {
        this.emitError(`bash: wait: \`${operand}': not a pid or valid job spec`);
        status = 127;
      }
    }
    this.env.lastExitCode = status;
    return true;
  }

  private *visitPipeline(node: Pipeline): Effects<void> {
    this.lastPipelineNegated = node.negated === true;
    if (node.negated) this.errexitSuppress++;
    try {
      yield* this.runPipelineStages(node);
    } finally {
      if (node.negated) this.errexitSuppress--;
    }
  }

  private *runPipelineStages(node: Pipeline): Effects<void> {
    if (node.commands.length === 1) {
      yield* this.visitCommand(node.commands[0]);
      if (!node.negated) this.env.setArray('PIPESTATUS', [String(this.env.lastExitCode)]);
      if (node.negated) {
        this.env.setArray('PIPESTATUS', [String(this.env.lastExitCode)]);
        this.env.lastExitCode = this.env.lastExitCode === 0 ? 1 : 0;
      }
      return;
    }

    const stageCodes: number[] = [];
    let pipeInput = '';
    const outer = this.log;
    const outerStdin = this.stdin;
    const deferredErrors = new OutputLog();
    for (let i = 0; i < node.commands.length; i++) {
      const cmd = node.commands[i];
      const stage = new OutputLog();
      this.log = stage;
      if (i > 0) this.stdin = new StdinSource(pipeInput);

      // Every stage except the last is itself a guard — its failure
      // must NOT trigger errexit, only the final stage's (or, with
      // pipefail, the aggregate) does.
      const isLast = i === node.commands.length - 1;
      if (isLast && this.backgroundLastStage) {
        this.backgroundLastStage = false;
        this.pendingBackground = true;
      }
      if (!isLast) this.errexitSuppress++;
      const savedNonLastStage = this.nonLastPipelineStage;
      if (!isLast) this.nonLastPipelineStage = true;
      const shellEnv = this.env;
      const runsInSubshell = !(isLast && isShellOptionEnabled(shellEnv, 'lastpipe'));
      if (runsInSubshell) this.env = shellEnv.createSubshell();
      const savedUmask = runsInSubshell ? this.captureUmask() : undefined;
      let stageStatus = 0;
      try {
        yield* this.visitCommand(cmd);
        stageStatus = this.env.lastExitCode;
      } catch (e) {
        stageStatus = e instanceof ReturnSignal ? e.exitCode : this.isolatedStatus(e);
      } finally {
        const stageBackground = this.env.get('!') ?? '';
        this.env = shellEnv;
        if (runsInSubshell && stageBackground !== '' && stageBackground !== shellEnv.get('!')) shellEnv.recordBackgroundPid(stageBackground);
        this.nonLastPipelineStage = savedNonLastStage;
        if (!isLast) this.errexitSuppress--;
        this.log = outer;
        this.stdin = outerStdin;
        this.restoreUmask(savedUmask);
      }
      this.env.lastExitCode = stageStatus;
      stageCodes.push(stageStatus);
      this.forward(stage, isLast ? outer : deferredErrors, isLast);
      pipeInput = stage.stream(1);
    }
    this.forward(deferredErrors, outer, false);
    this.env.setArray('PIPESTATUS', stageCodes.map(String));
    if (this.isPipefail()) {
      const nonZero = stageCodes.filter(c => c !== 0);
      this.env.lastExitCode = nonZero.length > 0 ? nonZero[nonZero.length - 1] : 0;
    }
    if (node.negated) this.env.lastExitCode = this.env.lastExitCode === 0 ? 1 : 0;
  }

  private *visitCommand(node: Command): Effects<void> {
    switch (node.type) {
      case 'SimpleCommand': yield* this.visitSimpleCommand(node); break;
      case 'IfClause': yield* this.withRedirections(node.redirections, () => this.visitIf(node)); break;
      case 'ForClause': yield* this.withRedirections(node.redirections, () => this.visitFor(node)); break;
      case 'WhileClause': yield* this.withRedirections(node.redirections, () => this.visitWhile(node)); break;
      case 'UntilClause': yield* this.withRedirections(node.redirections, () => this.visitUntil(node)); break;
      case 'CaseClause': yield* this.withRedirections(node.redirections, () => this.visitCase(node)); break;
      case 'FunctionDef': this.visitFunctionDef(node); break;
      case 'BraceGroup': yield* this.withRedirections(node.redirections, () => this.visitBraceGroup(node)); break;
      case 'Subshell': yield* this.withRedirections(node.redirections, () => this.visitSubshell(node)); break;
      case 'DoubleBracket': yield* this.visitDoubleBracket(node); break;
      case 'ArithmeticCommand': this.visitArithmeticCommand(node); break;
      case 'CStyleForClause': yield* this.visitCStyleFor(node); break;
    }
  }

  // ─── Simple Command ───────────────────────────────────────────

  private *visitSimpleCommand(node: SimpleCommand): Effects<void> {
    const restorePrefixAssignments = this.capturePrefixAssignments(node);
    try {
      yield* this.runSimpleCommand(node);
    } finally {
      restorePrefixAssignments();
    }
  }

  private procSubCounter = 63;
  private pendingOutSubs: Array<{ command: string; path: string }> = [];

  private *materializeProcSubs(node: SimpleCommand): Effects<SimpleCommand> {
    const hasProcSub = (w: Word): boolean =>
      w.type === 'ProcessSubstitution'
      || (w.type === 'CompoundWord' && w.parts.some(hasProcSub));
    if (!node.words.some(hasProcSub)
        && !node.redirections.some(r => hasProcSub(r.target))) {
      return node;
    }
    const words: Word[] = [];
    for (const word of node.words) words.push(yield* this.materializeWord(word));
    const redirections: Redirection[] = [];
    for (const redirection of node.redirections) redirections.push({ ...redirection, target: yield* this.materializeWord(redirection.target) });
    return { ...node, words, redirections };
  }

  private *materializeWord(word: Word): Effects<Word> {
    if (word.type === 'ProcessSubstitution') {
      const path = this.allocateProcSubPath();
      if (word.direction === 'in') {
        const output = yield* this.subcommandG(word.command);
        this.io?.writeFile(path, output, false);
      } else {
        this.io?.writeFile(path, '', false);
        this.pendingOutSubs.push({ command: word.command, path });
      }
      return { type: 'LiteralWord', value: path, position: word.position };
    }
    if (word.type === 'CompoundWord') {
      const parts: Word[] = [];
      for (const part of word.parts) parts.push(yield* this.materializeWord(part));
      return { ...word, parts } as Word;
    }
    return word;
  }

  private allocateProcSubPath(): string {
    const fd = this.procSubCounter--;
    if (this.procSubCounter < 20) this.procSubCounter = 63;
    const devPath = `/dev/fd/${fd}`;
    try {
      this.io?.writeFile(devPath, '', false);
      if (this.io?.readFile(devPath) !== null) return devPath;
    } catch { /* fall through to /tmp */ }
    return `/tmp/.psub-${fd}`;
  }

  /**
   * L'environnement que recoit un processus enfant : les variables
   * EXPORTEES, plus les affectations `VAR=val` posees devant la
   * commande — que bash exporte pour cette commande-la seulement. La
   * table complete du shell (`$UID`, `$HOSTNAME`, les parametres
   * positionnels) n'en fait pas partie.
   */
  private childEnvironment(prefixAssigned: string[]): Record<string, string> {
    const env = this.env.getExported();
    for (const name of prefixAssigned) {
      const value = this.env.get(name);
      if (value !== undefined) env[name] = value;
    }
    return env;
  }

  private flushOutSubs(): void {
    if (this.pendingOutSubs.length === 0) return;
    const pending = this.pendingOutSubs.splice(0);
    for (const sub of pending) {
      this.log.write(1, this.executeSubcommand(`${sub.command} < ${sub.path}`));
    }
  }

  private capturePrefixAssignments(node: SimpleCommand): () => void {
    if (node.words.length === 0 || declarationCommand(literalHeadName(node)) !== null) return () => {};
    const previous = node.assignments
      .filter((assign) => assign.arrayElements === undefined && assign.subscript === undefined)
      .map((assign) => ({ name: assign.name, value: this.env.get(assign.name) }));
    if (previous.length === 0) return () => {};
    return () => {
      for (const { name, value } of previous.reverse()) {
        if (this.env.isReadonly(name)) continue;
        if (value === undefined) this.env.withdrawScalar(name);
        else this.env.set(name, value);
      }
    };
  }

  private *applyCommandAssignments(
    node: SimpleCommand,
    declaration: DeclarationCommand | null,
  ): Effects<boolean> {
    const flags = declaration === null ? null : parseDeclarationFlags(node.words.slice(1).map(literalText), declaration);
    for (const assign of node.assignments) {
      try {
        if (declaration !== null && flags !== null) {
          const inFunction = this.env.getParent() !== null;
          const local = declaration === 'local' || ((declaration === 'declare' || declaration === 'typeset') && inFunction && !flags.global);
          if (declaration === 'local' && !inFunction) throw new Error('bash: local: can only be used in a function');
          const attributes = { ...flags.set, ...flags.clear };
          delete attributes.readonly;
          const kind = flags.kind ?? (assign.arrayElements !== undefined && assign.subscript !== undefined ? 'associative' : undefined);
          this.env.declare(assign.name, kind, attributes, local);
          if (flags.nameref && assign.value) {
            const refTarget = yield* this.expandWordG(assign.value);
            if (refTarget) {
              this.env.declareNameref(assign.name, refTarget);
              continue;
            }
          }
        }
        yield* this.applyAssignment(assign);
        if (flags?.set.readonly) this.env.declare(assign.name, undefined, { readonly: true }, false);
      } catch (e) {
        if (e instanceof BashRuntimeError || e instanceof ArithmeticError || this.isLineAbort(e)) throw e;
        if (e instanceof Error) this.emitError(e.message);
        this.env.lastExitCode = 1;
        return false;
      }
    }
    return true;
  }

  private *runSimpleCommand(rawNode: SimpleCommand): Effects<void> {
    if (rawNode.position !== undefined) this.currentLine = rawNode.position.line;
    yield* this.fireSignalTrap('DEBUG');
    const bareExec = rawNode.words.length === 1 && literalHeadName(rawNode) === 'exec';
    const node = bareExec ? rawNode : yield* this.materializeProcSubs(rawNode);
    this.lastSubstitutionStatus = null;
    if (!this.interactive && isShellOptionEnabled(this.env, 'noexec')) return;

    // Declaration commands (`local`, `declare`, `typeset`, `readonly`,
    // `export`) confine `name=value` arguments to the local scope. We
    // compute the head word once (cheap literal check) and have
    // `applyAssignment` skip the parent-walk by declaring each name
    // local first.
    const declaration = declarationCommand(literalHeadName(node));
    const absorbedDecl = node.assignments.length > 0 && declaration !== null;
    const assignmentsFirst = node.words.length === 0 || declaration !== null;

    if (assignmentsFirst) {
      if (!(yield* this.applyCommandAssignments(node, declaration))) {
        if (node.words.length === 0) throw new ExitSignal(1);
        return;
      }
      if (absorbedDecl && declaration !== null && parseDeclarationFlags(node.words.slice(1).map(literalText), declaration).names.length === 0) {
        this.env.lastExitCode = 0;
        return;
      }
      if (node.words.length === 0) {
        yield* this.runBareRedirections(node.redirections);
        return;
      }
    }

    const args = this.expandAliases(yield* this.expandWordsG(node.words));
    if (args.length === 0) {
      if (!assignmentsFirst) yield* this.applyCommandAssignments(node, null);
      yield* this.runBareRedirections(node.redirections);
      return;
    }
    const cmdName = args[0];
    this.env.set('_', args[args.length - 1]);
    if (isShellOptionEnabled(this.env, 'xtrace')) {
      this.log.write(2, `${this.env.get('PS4') ?? '+ '}${args.map(traceWord).join(' ')}\n`);
    }

    // `exec >> file 2>> errfile` (no command, only redirections) rewires
    // the shell's own stdout/stderr for the rest of the script.
    // `exec cmd …` (a real command follows) is unrelated, not handled here.
    if (cmdName === 'exec' && args.length === 1 && node.redirections.length > 0) {
      yield* this.applyExecRedirections(node.redirections);
      return;
    }

    const plan = yield* this.openRedirections(node.redirections);
    if (plan.failed) {
      this.env.lastExitCode = 1;
      return;
    }
    if (!assignmentsFirst) {
      if (!(yield* this.applyCommandAssignments(node, null))) return;
    }

    const backgroundedPid = yield* this.runWithPlan(plan, cmdName, () => this.dispatchCommand(args, node, plan));
    if (backgroundedPid !== undefined) {
      yield* this.bindBackgroundStdout(node.redirections, backgroundedPid);
      this.announceBackground(backgroundedPid);
    }

    this.flushOutSubs();

    // ERR honours the same guarded-context gate as `set -e`.
    if (this.errexitSuppress === 0 && this.env.lastExitCode !== 0) {
      yield* this.fireSignalTrap('ERR');
    }
  }

  private *runBareRedirections(redirections: Redirection[]): Effects<void> {
    if (redirections.length > 0 && this.io) {
      const plan = yield* this.openRedirections(redirections);
      if (plan.failed) {
        this.env.lastExitCode = 1;
        return;
      }
    }
    this.env.lastExitCode = this.lastSubstitutionStatus ?? 0;
  }

  private *dispatchCommand(args: string[], node: SimpleCommand, plan: RedirectPlan): Effects<number | undefined> {
    const cmdName = args[0];

    // Handle eval: re-parse and execute the joined args
    if (cmdName === 'eval') {
      const code = args.slice(1).join(' ');
      yield* this.executeEvalG(`${code}\n`, false, this.currentLine + (code.match(/\n/g)?.length ?? 0), `${this.env.get('0')}: eval`);
      return undefined;
    }

    // Handle source/.: read file and execute in current environment
    if ((cmdName === 'source' || cmdName === '.') && args.length > 1) {
      yield* this.executeSource(args[1], args.slice(2));
      return undefined;
    }

    const fn = this.functions.get(cmdName);
    if (cmdName === 'command') {
      // `command` runs its operand skipping function and alias lookup.
      yield* this.runCommandWord(args.slice(1));
    } else if (cmdName === 'exec') {
      if (args.length > 1) {
        this.execImage = args.slice(1);
        yield* this.runCommandWord(args.slice(1));
      }
    } else if (fn) {
      yield* this.callFunction(fn, args.slice(1), cmdName);
    } else if (cmdName === 'wait' && this.waitForJobs(args.slice(1))) {
      return undefined;
    } else if (cmdName === 'builtin') {
      yield* this.runBuiltinWord(args.slice(1));
    } else if (cmdName === 'hash') {
      yield* this.runHash(args.slice(1));
    } else if (cmdName === 'kill' && (yield* this.signalSelf(args.slice(1)))) {
      return undefined;
    } else if ((cmdName === 'break' || cmdName === 'continue') && this.loopDepth === 0) {
      this.emitError(`bash: ${cmdName}: only meaningful in a \`for', \`while', or \`until' loop`);
      this.env.lastExitCode = 0;
    } else if (cmdName === 'return' && this.functionStack.length === 0 && this.sourceDepth === 0) {
      this.emitError("bash: return: can only `return' from a function or sourced script");
      this.env.lastExitCode = 2;
    } else if (cmdName === 'exit' && args.length > 1 && !this.exitArgumentsValid(args.slice(1))) {
      return undefined;
    } else if (isBuiltin(cmdName)) {
      const aliasesBefore = cmdName === 'alias' ? new Map(this.aliases.list().map((alias) => [alias.name, alias.value])) : null;
      const result = executeBuiltin(
        cmdName, args.slice(1), this.env, this.functions, this.io ?? undefined,
        this.stdin ?? undefined, this.aliases, (fd) => this.fdInputs.get(fd),
      );
      this.lastLineOriented = false;
      this.emitResult({ ...result, lineOriented: false }, result.exitCode);
      this.env.lastExitCode = result.exitCode;
      if (aliasesBefore !== null) {
        for (const alias of this.aliases.list()) {
          if (aliasesBefore.get(alias.name) !== alias.value) this.aliasDefinedOnLine.set(alias.name, this.currentLine);
        }
      }
    } else {
      const stdinText = this.io?.ignoresStdin?.(args) ? undefined : this.stdin?.readRest();
      const fullArgs = stdinText ? [...args, stdinText] : args;
      const envSnapshot = this.childEnvironment(node.assignments.map(a => a.name));
      const background = this.pendingBackground || undefined;
      this.pendingBackground = false;
      // Stdout specifically (not a `2>`-only redirect, which leaves fd 1
      // attached to the terminal) is what real isatty(STDOUT_FILENO) sees.
      const outputPiped = plan.stdoutRedirected || this.nonLastPipelineStage;
      let result = normalizeResult(yield {
        argv: fullArgs, env: envSnapshot, background, outputPiped,
        stdin: stdinText,
      });
      this.lastLineOriented = result.lineOriented;
      if (result.stderr === undefined && result.output !== '' && (result.exitCode === 126 || result.exitCode === 127)) {
        result = { ...result, stderr: this.prefixDiagnostics(result.output.replace(/^(\/[^:]*): command not found/, '$1: No such file or directory'), true, undefined, cmdName === 'bash' || cmdName === 'sh'), interleaved: undefined, output: '' };
      }
      this.emitResult(result, result.exitCode, { builtin: isShellBuiltinName(cmdName) ? cmdName : undefined, childShell: cmdName === 'bash' || cmdName === 'sh' });
      this.env.lastExitCode = result.exitCode;
      if (result.backgroundPid !== undefined) {
        this.env.recordBackgroundPid(String(result.backgroundPid));
        this.externalChildren.add(String(result.backgroundPid));
        return result.backgroundPid;
      }
    }
    return undefined;
  }

  private absolutePath(path: string): string {
    return this.io!.resolvePath(path, this.env.get('PWD'));
  }

  private diagnosticPrefix(): string {
    if (this.interactive) return 'bash: ';
    return `${this.env.get('0')}: line ${this.currentLine}: `;
  }

  private prefixDiagnostics(text: string, bare = false, builtin?: string, childShell = false): string {
    if (childShell) return ensureTrailingNewline(text);
    const prefix = this.diagnosticPrefix();
    return ensureTrailingNewline(text).split(/(?<=\n)/).map((raw) => {
      const named = builtin !== undefined && raw.startsWith(`${builtin}: `) && !raw.startsWith(`${builtin}: usage: `);
      const line = named ? `bash: ${raw}` : raw.replace(/^bash: line \d+: /, 'bash: ');
      if (line.startsWith('bash: ')) return prefix + line.slice(6);
      return bare && /: (command not found|Permission denied|No such file or directory|Is a directory)\n$/.test(line) ? prefix + line : line;
    }).join('');
  }

  private emitError(text: string): void {
    this.log.write(2, this.prefixDiagnostics(text), 'never');
  }

  private emitResult(
    result: { output: string; stderr?: string; interleaved?: string; chunks?: ReadonlyArray<{ readonly fd: 1 | 2; readonly text: string }>; lineOriented?: boolean },
    exitCode: number,
    source: { builtin?: string; childShell?: boolean } = {},
  ): void {
    const newline: Newline = result.lineOriented === true ? 'always' : result.lineOriented === false ? 'never' : 'terminal';
    if (result.stderr === undefined) {
      this.log.write(1, result.output, newline, exitCode !== 0);
      return;
    }
    if (result.chunks !== undefined && result.chunks.length > 0) {
      for (const chunk of result.chunks) {
        this.log.write(chunk.fd, chunk.text, 'never');
      }
      return;
    }
    if (result.interleaved !== undefined && result.interleaved !== '') {
      const remaining = result.stderr.split('\n').filter((line) => line !== '');
      for (const line of result.interleaved.split(/(?<=\n)/)) {
        const text = line.endsWith('\n') ? line.slice(0, -1) : line;
        const index = remaining.indexOf(text);
        if (index === 0 || (index > 0 && text !== '')) {
          remaining.splice(index, 1);
          this.log.write(2, this.prefixDiagnostics(line, false, source.builtin, source.childShell), 'never');
        } else {
          this.log.write(1, line, newline);
        }
      }
      return;
    }
    this.log.write(1, result.output, newline);
    this.log.write(2, this.prefixDiagnostics(result.stderr, false, source.builtin, source.childShell), 'never');
  }

  /**
   * Command-position alias expansion. Substitutes the first word with its
   * alias body, repeating while the new head is itself an alias — but
   * never re-expanding a name already seen, so `alias ls='ls -p'`
   * terminates instead of looping forever.
   */
  private expandAliases(args: string[]): string[] {
    if (args.length === 0 || this.aliases.size === 0 || !isShellOptionEnabled(this.env, 'expand_aliases')) return args;
    let result = args;
    const seen = new Set<string>();
    while (result.length > 0) {
      const head = result[0];
      if (seen.has(head)) break;
      const alias = this.aliases.get(head);
      if (!alias || this.aliasDefinedOnLine.get(head) === this.currentLine) break;
      seen.add(head);
      result = [...alias.tokens(), ...result.slice(1)];
    }
    return result;
  }

  /**
   * Realise an Assignment node against the live environment. Handles
   * every Bash assignment form: scalar `VAR=val`, scalar append
   * `VAR+=val`, array literal `arr=(a b c)`, and array append
   * `arr+=(d e)`. The append variants concatenate strings / extend
   * arrays rather than replacing them.
   */
  private *applyAssignment(assign: Assignment): Effects<void> {
    const { name } = assign;
    if (assign.arrayElements !== undefined) {
      const elements = yield* this.expandWordsG(assign.arrayElements);
      const explicit = elements.map((element) => /^\[([^\]]*)\]=(.*)$/s.exec(element));
      const associative = this.env.isAssoc(name) || (elements.length > 0 && explicit.every((match) => match !== null) && !this.env.getArray(name) && assign.subscript !== undefined);
      if (this.env.isAssoc(name) || associative) {
        if (!this.env.isAssoc(name)) this.env.declareAssoc(name);
        if (!assign.append) this.env.clearAssoc(name);
        for (const match of explicit) if (match !== null) this.env.setAssocElement(name, match[1], match[2]);
        return;
      }
      if (!assign.append) this.env.setArray(name, []);
      let next = this.env.getArrayIndices(name).reduce((largest, index) => Math.max(largest, index + 1), 0);
      elements.forEach((element, position) => {
        const match = explicit[position];
        if (match !== null) {
          next = Number(evaluateArithmetic(match[1], this.env));
          this.env.setArrayElement(name, next, match[2]);
        } else {
          this.env.setArrayElement(name, next, element);
        }
        next++;
      });
      return;
    }
    const value = assign.value ? yield* this.expandWordG(assign.value) : '';
    if (assign.subscript !== undefined) {
      const subscript = yield* this.expandTextG(assign.subscript);
      if (this.env.isAssoc(name)) {
        this.env.setAssocElement(name, subscript, assign.append ? (this.env.getAssocElement(name, subscript) ?? '') + value : value);
        return;
      }
      const index = Number(evaluateArithmetic(subscript, this.env));
      const previous = assign.append ? (this.env.getArrayElement(name, index) ?? '') : '';
      this.env.setArrayElement(name, index, previous + value);
      return;
    }
    if (assign.append) this.env.appendScalar(name, value);
    else this.env.set(name, value);
    if (isShellOptionEnabled(this.env, 'allexport')) this.env.export(name);
  }

  /**
   * The `command` builtin: run an operand skipping function and alias
   * lookup, or — with `-v` / `-V` — describe how it would resolve.
   */
  private *runCommandWord(rest: string[]): Effects<void> {
    let mode: 'run' | 'v' | 'V' = 'run';
    let i = 0;
    for (; i < rest.length; i++) {
      const a = rest[i];
      if (a === '-v') { mode = 'v'; continue; }
      if (a === '-V') { mode = 'V'; continue; }
      if (a === '-p') continue;            // "use a default PATH" — accepted
      if (a === '--') { i++; break; }
      break;
    }
    const target = rest.slice(i);
    if (target.length === 0) { this.env.lastExitCode = 0; return; }
    const name = target[0];

    if (mode !== 'run') {
      const desc = yield* this.describeResolution(name, mode === 'V');
      if (desc !== null) {
        this.log.write(1, desc + '\n');
        this.env.lastExitCode = 0;
      } else {
        if (mode === 'V') this.emitError(`bash: command: ${name}: not found`);
        this.env.lastExitCode = 1;
      }
      return;
    }

    // Execute, skipping function and alias resolution.
    if (isBuiltin(name)) {
      const r = executeBuiltin(
        name, target.slice(1), this.env, this.functions,
        this.io ?? undefined, this.stdin ?? undefined, this.aliases, (fd) => this.fdInputs.get(fd),
      );
      this.emitResult({ ...r, lineOriented: false }, r.exitCode);
      this.env.lastExitCode = r.exitCode;
      return;
    }
    const stdinText = this.io?.ignoresStdin?.(target) ? undefined : this.stdin?.readRest();
    const fullArgs = stdinText ? [...target, stdinText] : target;
    const envSnapshot = this.childEnvironment([]);
    const result = normalizeResult(yield {
      argv: fullArgs, env: envSnapshot, stdin: stdinText,
    });
    this.emitResult(result, result.exitCode);
    this.env.lastExitCode = result.exitCode;
  }

  /**
   * Describe how `name` resolves for `command -v` (terse) / `-V`
   * (verbose). Builtins and functions are answered here; any other name
   * is probed against the external executor, which owns the command
   * registry and the VFS.
   */
  private *describeResolution(name: string, verbose: boolean): Effects<string | null> {
    if (isBuiltin(name)) {
      return verbose ? `${name} is a shell builtin` : name;
    }
    if (this.functions.has(name)) {
      return verbose ? `${name} is a function` : name;
    }
    const probe = normalizeResult(yield { argv: ['command', verbose ? '-V' : '-v', name] });
    const text = probe.output.trim();
    if (probe.exitCode === 0 && text) return text;
    return null;
  }

  /** Apply output redirections to captured output. */
  private *bindBackgroundStdout(redirections: Redirection[], pid: number): Effects<void> {
    if (!this.io?.bindBackgroundStdout) return;
    let stdoutPath: string | undefined;
    for (const redir of redirections) {
      const target = yield* this.expandWordG(redir.target);
      if (redir.fd === 2) {
        if (redir.op === '>' || redir.op === '>>') this.io.bindBackgroundStderr?.(pid, this.absolutePath(target), redir.op === '>>');
        else if (redir.op === '>&' && target === '1' && stdoutPath !== undefined) this.io.bindBackgroundStderr?.(pid, stdoutPath, true);
      } else if ((redir.op === '>' || redir.op === '>>') && (redir.fd === undefined || redir.fd === 1)) {
        stdoutPath = this.absolutePath(target);
        this.io.bindBackgroundStdout(pid, stdoutPath);
      } else if (redir.op === '<' && (redir.fd === undefined || redir.fd === 0)) {
        this.io.holdBackgroundStdin?.(pid, this.absolutePath(target));
      }
    }
  }

  // ─── Redirections ─────────────────────────────────────────────

  private *openRedirections(redirections: Redirection[]): Effects<RedirectPlan> {
    const plan: RedirectPlan = { sinks: new Map(), failed: false, stdoutRedirected: false };
    if (redirections.length === 0) return plan;
    const sinkOf = (fd: number): Sink | undefined =>
      plan.sinks.get(fd) ?? this.fdOutputs.get(fd) ?? (fd === 1 ? { kind: 'out' } : fd === 2 ? { kind: 'err' } : undefined);
    const fail = (message: string): RedirectPlan => {
      this.emitError(message);
      plan.failed = true;
      return plan;
    };
    for (const redir of redirections) {
      const target = yield* this.expandWordG(yield* this.materializeWord(redir.target));
      const op = redir.op;
      if (op === '<<<' || op === '<<') {
        plan.stdin = target + '\n';
        continue;
      }
      if (this.io === null) continue;
      if (op === '<') {
        const descriptor = redir.fd ?? 0;
        const content = this.io.readFile(this.absolutePath(target));
        if (content === null) return fail(`bash: ${target}: No such file or directory`);
        if (descriptor === 0) plan.stdin = content;
        else this.fdInputs.set(descriptor, new StdinSource(content));
        continue;
      }
      if (op === '<&') {
        const descriptor = redir.fd ?? 0;
        if (target === '-') {
          if (descriptor !== 0) this.fdInputs.delete(descriptor);
          continue;
        }
        const source = this.fdInputs.get(Number(target));
        if (descriptor === 0 && source !== undefined) plan.stdin = source.readRest();
        continue;
      }
      if (op === '>&' && /^\d+$/.test(target) || (op === '>&' && target === '-')) {
        const descriptor = redir.fd ?? 1;
        if (target === '-') {
          plan.sinks.set(descriptor, { kind: 'closed' });
          continue;
        }
        const source = sinkOf(Number(target));
        if (source === undefined) return fail(`bash: ${target}: Bad file descriptor`);
        plan.sinks.set(descriptor, source);
        continue;
      }
      const both = op === '&>' || op === '&>>' || op === '>&';
      const append = op === '>>' || op === '&>>';
      const descriptor = both ? 1 : (redir.fd ?? 1);
      const path = this.absolutePath(target);
      if (op === '>' && isShellOptionEnabled(this.env, 'noclobber') && this.io.stat?.(path)?.type === 'file') {
        return fail(`bash: ${target}: cannot overwrite existing file`);
      }
      try {
        this.io.writeFile(path, '', append);
      } catch (e) {
        return fail(e instanceof Error ? this.redirectFailureText(e, undefined) : `bash: ${target}: cannot redirect`);
      }
      const sink: Sink = { kind: 'file', path };
      plan.sinks.set(descriptor, sink);
      if (both) plan.sinks.set(2, sink);
    }
    plan.stdoutRedirected = plan.sinks.has(1) && plan.sinks.get(1)?.kind !== 'out';
    return plan;
  }

  private *runWithPlan<T>(plan: RedirectPlan, command: string | undefined, body: () => Effects<T>): Effects<T> {
    const savedStdin = this.stdin;
    if (plan.stdin !== undefined) this.stdin = new StdinSource(plan.stdin);
    const outer = this.log;
    const capture = plan.sinks.size > 0;
    const inner = capture ? new OutputLog() : null;
    if (inner !== null) this.log = inner;
    try {
      return yield* body();
    } finally {
      this.stdin = savedStdin;
      if (inner !== null) {
        this.log = outer;
        this.deliver(plan, inner, command);
      }
    }
  }

  private *withRedirections(redirections: Redirection[] | undefined, body: () => Effects<void>): Effects<void> {
    if (redirections === undefined || redirections.length === 0 || !this.io) {
      yield* body();
      return;
    }
    const plan = yield* this.openRedirections(redirections);
    if (plan.failed) {
      this.env.lastExitCode = 1;
      return;
    }
    yield* this.runWithPlan(plan, undefined, body);
  }

  private deliver(plan: RedirectPlan, captured: OutputLog, command: string | undefined): void {
    for (const chunk of captured.entries()) {
      const fd = chunk.fd === 2 || (chunk.ambiguous && plan.sinks.has(1) !== plan.sinks.has(2)) ? 2 : 1;
      const sink = plan.sinks.get(fd) ?? this.fdOutputs.get(fd) ?? (fd === 1 ? { kind: 'out' as const } : { kind: 'err' as const });
      switch (sink.kind) {
        case 'out': this.log.write(1, fd === 2 && chunk.ambiguous ? ensureTrailingNewline(chunk.text) : chunk.text, fd === 2 && chunk.ambiguous ? 'never' : chunk.newline, chunk.ambiguous && chunk.fd === 1); break;
        case 'err': this.log.write(2, chunk.fd === 2 ? chunk.text : ensureTrailingNewline(chunk.text), 'never'); break;
        case 'file':
          try {
            this.io!.writeFile(sink.path, chunk.newline === 'always' ? ensureTrailingNewline(chunk.text) : chunk.text, true);
          } catch (e) {
            if (e instanceof Error) this.emitError(this.redirectFailureText(e, command));
            this.env.lastExitCode = 1;
          }
          break;
        default: break;
      }
    }
  }

  /**
   * `exec >> file 2>> errfile` — resolve each redirection target and
   * remember it as the shell's own stdout/stderr for the remainder of
   * this script; `runProgram` flushes accumulated output there instead
   * of returning it as terminal text once the script finishes. Higher
   * descriptors (`exec 3>file`, `exec 3<file`, `exec 3>&-`) persist in
   * the descriptor tables.
   */
  private *applyExecRedirections(redirections: Redirection[]): Effects<void> {
    for (const redir of redirections) {
      if (redir.target.type === 'ProcessSubstitution' && redir.target.direction === 'out' && (redir.op === '>' || redir.op === '>>') && (redir.fd ?? 1) === 1) {
        this.execRedirect ??= { from: this.log.entries().length };
        this.execRedirect.stdout = { path: this.allocateProcSubPath(), append: false, pipe: redir.target.command };
        continue;
      }
      const target = yield* this.expandWordG(redir.target);
      const fd = redir.fd ?? (redir.op === '<' || redir.op === '<&' ? 0 : 1);
      if (redir.op === '>&' && fd === 2 && target === '1' && this.execRedirect?.stdout !== undefined) {
        this.execRedirect.mergeStderr = true;
        continue;
      }
      if (redir.op === '<' && fd >= 3) {
        const content = this.io?.readFile(this.absolutePath(target));
        if (content == null) {
          this.emitError(`bash: ${target}: No such file or directory`);
          this.env.lastExitCode = 1;
          return;
        }
        this.fdInputs.set(fd, new StdinSource(content));
        continue;
      }
      if (target === '-') {
        this.fdOutputs.delete(fd);
        this.fdInputs.delete(fd);
        continue;
      }
      if (redir.op === '>&' && fd >= 3 && /^\d+$/.test(target)) {
        const source = Number(target);
        const sink: Sink | undefined = source === 1 ? { kind: 'out' } : source === 2 ? { kind: 'err' } : this.fdOutputs.get(source);
        if (sink === undefined) {
          this.emitError(`bash: ${source}: Bad file descriptor`);
          this.env.lastExitCode = 1;
          return;
        }
        this.fdOutputs.set(fd, sink);
        continue;
      }
      if (redir.op !== '>' && redir.op !== '>>') continue;
      const path = this.io ? this.absolutePath(target) : target;
      const append = redir.op === '>>';
      if (fd >= 3) {
        this.io?.writeFile(path, '', append);
        this.fdOutputs.set(fd, { kind: 'file', path });
        continue;
      }
      this.execRedirect ??= { from: this.log.entries().length };
      if (fd === 2) this.execRedirect.stderr = { path, append };
      else this.execRedirect.stdout = { path, append };
    }
    this.env.lastExitCode = 0;
  }

  private redirectFailureText(error: Error, command: string | undefined): string {
    if (!(error instanceof RedirectWriteError)) return error.message;
    if (command === undefined) return `bash: write error: ${error.reason}`;
    return `${isBuiltin(command) ? 'bash: ' : ''}${command}: write error: ${error.reason}`;
  }

  // ─── If ───────────────────────────────────────────────────────

  private *visitIf(node: IfClause): Effects<void> {
    this.errexitSuppress++;
    try { yield* this.visitCommandList(node.condition); }
    finally { this.errexitSuppress--; }
    if (this.env.lastExitCode === 0) {
      yield* this.visitCommandList(node.thenBody);
      return;
    }

    for (const elif of node.elifClauses) {
      this.errexitSuppress++;
      try { yield* this.visitCommandList(elif.condition); }
      finally { this.errexitSuppress--; }
      if (this.env.lastExitCode === 0) {
        yield* this.visitCommandList(elif.body);
        return;
      }
    }

    if (node.elseBody) {
      yield* this.visitCommandList(node.elseBody);
      return;
    }

    // POSIX: "the exit status of if shall be ... zero if no condition
    // tested true."
    this.env.lastExitCode = 0;
  }

  // ─── Loops ────────────────────────────────────────────────────

  private *runLoopBody(body: CommandList): Effects<'continue' | 'break'> {
    this.loopDepth++;
    try {
      yield* this.visitCommandList(body);
    } catch (e) {
      if (e instanceof BreakSignal) {
        if (e.levels > 1) throw new BreakSignal(e.levels - 1);
        return 'break';
      }
      if (e instanceof ContinueSignal) {
        if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
        return 'continue';
      }
      throw e;
    } finally {
      this.loopDepth--;
    }
    return 'continue';
  }

  private *visitFor(node: ForClause): Effects<void> {
    const items = node.words
      ? yield* this.expandWordsG(node.words)
      : this.env.getPositionalArgs();

    if (node.select === true) {
      yield* this.runSelect(node, items);
      return;
    }
    let status = 0;
    for (const item of items) {
      this.env.set(node.variable, item);
      const outcome = yield* this.runLoopBody(node.body);
      status = this.env.lastExitCode;
      if (outcome === 'break') break;
    }
    this.env.lastExitCode = status;
  }

  private *runSelect(node: ForClause, items: string[]): Effects<void> {
    let status = 0;
    let showMenu = true;
    for (;;) {
      if (showMenu) this.log.write(2, items.map((item, index) => `${index + 1}) ${item}\n`).join(''));
      this.log.write(2, this.env.get('PS3') ?? '#? ');
      const record = this.stdin?.readRecord('\n') ?? null;
      if (record === null) {
        this.log.write(2, '\n');
        break;
      }
      this.env.set('REPLY', record.text);
      if (record.text === '') {
        showMenu = true;
        continue;
      }
      showMenu = false;
      const choice = Number(record.text);
      this.env.set(node.variable, Number.isInteger(choice) && choice >= 1 && choice <= items.length ? items[choice - 1] : '');
      const outcome = yield* this.runLoopBody(node.body);
      status = this.env.lastExitCode;
      if (outcome === 'break') break;
    }
    this.env.lastExitCode = status;
  }

  private *visitWhile(node: WhileClause): Effects<void> {
    yield* this.runConditionLoop(node.condition, node.body, true);
  }

  private *visitUntil(node: UntilClause): Effects<void> {
    yield* this.runConditionLoop(node.condition, node.body, false);
  }

  private *runConditionLoop(condition: CommandList, body: CommandList, whileTrue: boolean): Effects<void> {
    const MAX_ITERATIONS = 10000;
    const parkAfterFirst = (this.daemonMode || this.daemonDepth > 0) && isUnconditional(condition, whileTrue);
    let iterations = 0;
    let status = 0;
    while (iterations++ < MAX_ITERATIONS) {
      this.errexitSuppress++;
      try { yield* this.visitCommandList(condition); }
      finally { this.errexitSuppress--; }
      if ((this.env.lastExitCode === 0) !== whileTrue) break;
      if (parkAfterFirst && iterations > 1) throw new DaemonParkSignal(this.log.terminal(), this);
      const outcome = yield* this.runLoopBody(body);
      status = this.env.lastExitCode;
      if (outcome === 'break') break;
    }
    this.env.lastExitCode = status;
  }

  // ─── Case ─────────────────────────────────────────────────────

  private *visitCase(node: CaseClause): Effects<void> {
    const value = yield* this.expandWordG(node.word);
    const nocase = isShellOptionEnabled(this.env, 'nocasematch');

    let fallthrough = false;
    let ran = false;
    for (const item of node.items) {
      let matched = fallthrough;
      if (!matched) {
        for (const pattern of item.patterns) {
          const pat = yield* this.expandPatternG(pattern);
          if (fnmatch(pat, value, { extglob: true, nocase })) { matched = true; break; }
        }
      }
      if (!matched) continue;
      ran = true;
      if (item.body) yield* this.visitCommandList(item.body);
      const terminator = item.terminator ?? ';;';
      if (terminator === ';&') { fallthrough = true; continue; }
      if (terminator === ';;&') { fallthrough = false; continue; }
      return;
    }
    if (!ran) this.env.lastExitCode = 0;
  }

  // ─── Function Definition ──────────────────────────────────────

  private visitFunctionDef(node: FunctionDef): void {
    this.functions.set(node.name, node.body);
    this.env.lastExitCode = 0;
  }

  private *callFunction(body: Command, args: string[], name: string): Effects<void> {
    // Create a child environment for function scope (supports `local`)
    const savedEnv = this.env;
    this.functionStack.unshift(name);
    this.callerLines.unshift(this.currentLine);
    this.publishCallFrames(savedEnv);
    const childEnv = this.env.createChild();
    this.env = childEnv;
    this.env.setPositionalArgs(args);
    try {
      yield* this.visitCommand(body);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        this.env.lastExitCode = e.exitCode;
      } else {
        throw e;
      }
    } finally {
      yield* this.fireSignalTrap('RETURN');
      savedEnv.lastExitCode = this.env.lastExitCode;
      this.env = savedEnv;
      this.functionStack.shift();
      this.callerLines.shift();
      this.publishCallFrames(savedEnv);
    }
  }

  private *runBuiltinWord(rest: string[]): Effects<void> {
    const name = rest[0];
    if (name === undefined) {
      this.env.lastExitCode = 0;
      return;
    }
    if (!isBuiltin(name) && name !== 'hash' && name !== 'builtin') {
      this.emitError(`bash: builtin: ${name}: not a shell builtin`);
      this.env.lastExitCode = 1;
      return;
    }
    const result = executeBuiltin(
      name, rest.slice(1), this.env, this.functions, this.io ?? undefined,
      this.stdin ?? undefined, this.aliases, (fd) => this.fdInputs.get(fd),
    );
    this.emitResult({ ...result, lineOriented: false }, result.exitCode);
    this.env.lastExitCode = result.exitCode;
  }

  private *runHash(rest: string[]): Effects<void> {
    const names = rest.filter((word) => !word.startsWith('-'));
    if (names.length === 0) {
      if (!rest.includes('-r')) this.log.write(1, 'hash: hash table empty\n');
      this.env.lastExitCode = 0;
      return;
    }
    let status = 0;
    for (const name of names) {
      if (rest.includes('-p') || rest.includes('-d')) continue;
      const found = yield* this.describeResolution(name, false);
      if (found === null) {
        this.emitError(`bash: hash: ${name}: not found`);
        status = 1;
      }
    }
    this.env.lastExitCode = status;
  }

  private *signalSelf(rest: string[]): Effects<boolean> {
    let specification = 'TERM';
    const operands: string[] = [];
    for (let index = 0; index < rest.length; index++) {
      const word = rest[index];
      if (word === '-s' || word === '-n') { specification = rest[++index] ?? specification; continue; }
      if (/^-(?!l|L)[A-Za-z0-9]+$/.test(word) && operands.length === 0) { specification = word.slice(1); continue; }
      operands.push(word);
    }
    const own = String(this.env.get('$'));
    if (operands.length === 0 || !operands.every((operand) => operand === own)) return false;
    const name = specification === '0' ? 'EXIT' : signalName(specification);
    if (name === null) {
      this.emitError(`bash: kill: ${specification}: invalid signal specification`);
      this.env.lastExitCode = 1;
      return true;
    }
    this.env.lastExitCode = 0;
    if (specification === '0') return true;
    const handler = this.lookupTrapInherited(name);
    if (handler !== undefined) {
      if (handler !== '') yield* this.executeEvalG(handler, false, this.currentLine);
      return true;
    }
    if (terminatesByDefault(name)) throw new ExitSignal(128 + signalNumber(name));
    return true;
  }

  // ─── Eval ─────────────────────────────────────────────────────

  private *executeEvalG(code: string, sourced = false, firstLine = 1, label?: string): Effects<void> {
    try {
      const ast = parseScript(code, firstLine, this.interactive || isShellOptionEnabled(this.env, 'extglob') ? 'always' : 'declared');
      yield* this.visitCommandList(ast.body);
      if (ast.syntaxFailure !== undefined) this.reportSyntaxFailure(ast.syntaxFailure, label ?? this.syntaxLabel());
    } catch (e) {
      if (sourced && e instanceof ReturnSignal) {
        this.env.lastExitCode = e.exitCode;
        return;
      }
      if (e instanceof ExitSignal || e instanceof ReturnSignal ||
          e instanceof BreakSignal || e instanceof ContinueSignal ||
          e instanceof BashRuntimeError || e instanceof ArithmeticError || e instanceof DaemonParkSignal) {
        throw e;
      }
      this.env.lastExitCode = 1;
    }
  }

  // ─── Source ───────────────────────────────────────────────────

  private *executeSource(filePath: string, extraArgs: string[]): Effects<void> {
    if (!this.io) {
      this.env.lastExitCode = 1;
      return;
    }
    const path = this.absolutePath(filePath);
    const content = this.io.readFile(path);
    if (content === null) {
      this.emitError(`bash: ${filePath}: No such file or directory`);
      this.env.lastExitCode = 1;
      return;
    }
    const saved = extraArgs.length > 0 ? this.env.getPositionalArgs() : null;
    if (saved !== null) this.env.setPositionalArgs(extraArgs);
    this.sourceDepth++;
    try {
      yield* this.executeEvalG(content, true, 1, filePath);
    } finally {
      this.sourceDepth--;
      if (saved !== null) this.env.setPositionalArgs(saved);
    }
  }

  // ─── Brace Group & Subshell ───────────────────────────────────

  private captureUmask(): number | undefined {
    return this.io?.getUmask?.();
  }

  private restoreUmask(saved: number | undefined): void {
    if (saved !== undefined) this.io?.setUmask?.(saved);
  }

  private announceBackground(pid: number): void {
    if (!this.interactive) return;
    const text = this.io?.backgroundAnnouncement?.(pid);
    if (text) this.log.write(1, `${text}\n`, 'never');
  }

  private *runBackgroundGroup(group: Subshell | BraceGroup): Effects<void> {
    const io = this.io!;
    const pid = io.beginBackgroundSubshell!(backgroundGroupText(group));
    this.env.recordBackgroundPid(String(pid));
    const parentEnv = this.env;
    const parentLog = this.log;
    const parentImage = this.execImage;
    const childEnv = parentEnv.createSubshell();
    this.env = childEnv;
    this.log = new OutputLog();
    this.execImage = null;
    let output = '';
    let parked = false;
    const savedUmask = this.captureUmask();
    this.daemonDepth++;
    try {
      yield* this.withRedirections(group.redirections, () => this.visitCommandList(group.body));
    } catch (error) {
      if (error instanceof ExitSignal) childEnv.lastExitCode = error.exitCode;
      else if (error instanceof DaemonParkSignal) parked = true;
      else throw error;
    } finally {
      this.restoreUmask(savedUmask);
      this.daemonDepth--;
      output = this.log.terminal();
      this.log = parentLog;
      this.env = parentEnv;
    }
    io.endBackgroundSubshell!(pid, {
      cwd: childEnv.get('PWD') ?? io.resolvePath('.'), image: this.execImage, output, exitCode: childEnv.lastExitCode, parked,
    });
    if (parked || this.execImage !== null) this.externalChildren.add(String(pid));
    else this.jobs.set(String(pid), childEnv.lastExitCode);
    this.execImage = parentImage;
    this.announceBackground(pid);
  }

  private *visitBraceGroup(node: BraceGroup): Effects<void> {
    yield* this.visitCommandList(node.body);
  }

  private *visitSubshell(node: Subshell): Effects<void> {
    // Subshell forks an isolated snapshot — writes never leak back.
    const savedEnv = this.env;
    const childEnv = this.env.createSubshell();
    const savedUmask = this.captureUmask();
    this.env = childEnv;
    let status: number;
    try {
      try {
        yield* this.visitCommandList(node.body);
        status = childEnv.lastExitCode;
      } catch (e) {
        status = this.isolatedStatus(e);
      }
      childEnv.lastExitCode = status;
      yield* this.fireExitTrap();
    } finally {
      this.env = savedEnv;
      this.restoreUmask(savedUmask);
    }
    savedEnv.lastExitCode = status;
  }

  // ─── [[ … ]] Extended Test ────────────────────────────────────

  private *visitDoubleBracket(node: DoubleBracket): Effects<void> {
    const value = yield* this.evalDB(node.expr);
    this.env.lastExitCode = value ? 0 : 1;
  }

  /** Recursive evaluator for the `[[ … ]]` expression tree. */
  private *evalDB(expr: DBExpr): Effects<boolean> {
    switch (expr.kind) {
      case 'or':  return (yield* this.evalDB(expr.left)) || (yield* this.evalDB(expr.right));
      case 'and': return (yield* this.evalDB(expr.left)) && (yield* this.evalDB(expr.right));
      case 'not': return !(yield* this.evalDB(expr.expr));
      case 'lit': return (yield* this.expandWordG(expr.word)) !== '';
      case 'unary': {
        const v = yield* this.expandWordG(expr.arg);
        return yield* this.dbUnary(expr.op, v);
      }
      case 'binary': {
        const lhs = yield* this.expandWordG(expr.lhs);
        if (expr.op === '=' || expr.op === '==' || expr.op === '!=') {
          const pattern = yield* this.expandPatternG(expr.rhs);
          const matched = fnmatch(pattern, lhs, { extglob: true, nocase: isShellOptionEnabled(this.env, 'nocasematch') });
          return expr.op === '!=' ? !matched : matched;
        }
        const rhs = yield* this.expandWordG(expr.rhs);
        return yield* this.dbBinary(expr.op, lhs, rhs, expr.rhs);
      }
    }
  }

  private *dbUnary(op: string, v: string): Effects<boolean> {
    switch (op) {
      case '-n': return v.length > 0;
      case '-z': return v.length === 0;
      case '-v': return this.variableIsSet(v);
      case '-o': return isShellOptionEnabled(this.env, v);
    }
    const result = normalizeResult(yield { argv: ['test', op, v], env: this.childEnvironment([]) });
    return result.exitCode === 0;
  }

  private variableIsSet(reference: string): boolean {
    const element = /^([A-Za-z_][A-Za-z0-9_]*)\[(.+)\]$/.exec(reference);
    if (element === null) return this.env.isSet(reference);
    const [, name, subscript] = element;
    if (this.env.isAssoc(name)) return this.env.getAssocElement(name, subscript) !== undefined;
    return this.env.getArrayElement(name, Number(evaluateArithmetic(subscript, this.env))) !== undefined;
  }

  private *dbBinary(op: string, lhs: string, rhs: string, rhsWord: Word): Effects<boolean> {
    switch (op) {
      case '=~': return this.regexMatch(lhs, rhs, rhsWord);
      case '<':  return lhs < rhs;
      case '>':  return lhs > rhs;
      case '-eq':
      case '-ne':
      case '-lt':
      case '-le':
      case '-gt':
      case '-ge': {
        const left = BigInt(evaluateArithmetic(lhs, this.env));
        const right = BigInt(evaluateArithmetic(rhs, this.env));
        switch (op) {
          case '-eq': return left === right;
          case '-ne': return left !== right;
          case '-lt': return left < right;
          case '-le': return left <= right;
          case '-gt': return left > right;
          default: return left >= right;
        }
      }
    }
    const result = normalizeResult(yield { argv: ['test', lhs, op, rhs], env: this.childEnvironment([]) });
    return result.exitCode === 0;
  }

  /**
   * `=~` matches LHS against RHS as an ERE. Bash treats unquoted RHS
   * as a regex and quoted RHS as a literal; we approximate via the
   * Word AST (LiteralWord → regex, quoted forms → literal).
   */
  private regexMatch(value: string, pattern: string, patternWord: Word): boolean {
    const source = this.buildRegexPattern(patternWord, pattern);
    try {
      const re = new RegExp(source, isShellOptionEnabled(this.env, 'nocasematch') ? 'i' : '');
      const m = re.exec(value);
      if (!m) return false;
      this.env.setArray('BASH_REMATCH', m.map(g => g ?? ''));
      return true;
    } catch {
      return false;
    }
  }

  private buildRegexPattern(word: Word, expandedWhole: string): string {
    if (word.type === 'SingleQuotedWord' || word.type === 'DoubleQuotedWord') {
      return escapeRegex(expandWord(word, this.env, (cmd) => this.executeSubcommand(cmd)));
    }
    if (word.type === 'CompoundWord') {
      return word.parts
        .map(part => this.buildRegexPattern(part, expandWord(part, this.env, (cmd) => this.executeSubcommand(cmd))))
        .join('');
    }
    return expandedWhole;
  }

  // ─── (( arithmetic command )) ────────────────────────────────

  private visitArithmeticCommand(node: ArithmeticCommand): void {
    try {
      const result = evaluateArithmetic(node.raw ?? node.expression, this.env);
      // Bash: exit 0 iff the arithmetic result is non-zero.
      this.env.lastExitCode = BigInt(result) !== 0n ? 0 : 1;
    } catch (e) {
      if (!(e instanceof ArithmeticError)) throw e;
      this.emitError(`bash: ((: ${e.message}`);
      this.env.lastExitCode = 1;
    }
  }

  // ─── for ((init; cond; update)) ──────────────────────────────

  private *visitCStyleFor(node: CStyleForClause): Effects<void> {
    const MAX = 100_000;
    if (node.init) evaluateArithmetic(node.init, this.env);
    let iters = 0;
    while (iters++ < MAX) {
      if (node.cond) {
        const v = evaluateArithmetic(node.cond, this.env);
        if (Number.parseInt(v, 10) === 0) break;
      }
      this.loopDepth++;
      try {
        yield* this.visitCommandList(node.body);
      } catch (e) {
        if (e instanceof BreakSignal) {
          if (e.levels > 1) throw new BreakSignal(e.levels - 1);
          break;
        }
        if (e instanceof ContinueSignal) {
          if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
        } else { throw e; }
      } finally {
        this.loopDepth--;
      }
      if (node.update) evaluateArithmetic(node.update, this.env);
    }
  }
}

/**
 * True for the bash "declaration commands" that confine `name=value`
 * arguments to the local scope. `readonly` and `export` are NOT in
 * this list — they keep the parent-walking semantics.
 */
/** True for a bare `true`/`:` (expectTrue) or `false` (!expectTrue) condition
 *  — an unconditional loop head like `while true`/`until false`. */
function isUnconditional(condition: CommandList, expectTrue: boolean): boolean {
  if (condition.commands.length !== 1) return false;
  const andOr = condition.commands[0];
  if (andOr.rest.length !== 0) return false;
  const pipeline = andOr.first;
  if (pipeline.commands.length !== 1 || pipeline.negated) return false;
  const cmd = pipeline.commands[0];
  if (cmd.type !== 'SimpleCommand' || cmd.words.length !== 1 || cmd.assignments.length !== 0) return false;
  const w = cmd.words[0];
  if (w.type !== 'LiteralWord') return false;
  return expectTrue ? (w.value === 'true' || w.value === ':') : w.value === 'false';
}

function declarationCommand(name: string): DeclarationCommand | null {
  return name === 'local' || name === 'declare' || name === 'typeset' || name === 'readonly' || name === 'export' ? name : null;
}

function literalText(word: Word): string {
  return word.type === 'LiteralWord' ? word.value : '';
}

function literalHeadName(node: SimpleCommand): string {
  const head = node.words[0];
  return head && head.type === 'LiteralWord' ? head.value : '';
}


function escapeRegex(s: string): string {
  return s.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
}

function traceWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
