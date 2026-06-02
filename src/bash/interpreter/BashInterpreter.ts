/**
 * BashInterpreter — Walks the AST and executes bash commands.
 *
 * Orchestrates: Environment, Expansion, Builtins, and external command delegation.
 * Each visit method returns an exit code (0 = success).
 */

import type {
  Program, CommandList, AndOrList, Pipeline, Command,
  SimpleCommand, IfClause, ForClause, WhileClause, UntilClause,
  CaseClause, FunctionDef, BraceGroup, Subshell,
  DoubleBracket, DBExpr, ArithmeticCommand, CStyleForClause,
  Word, Assignment,
} from '@/bash/parser/ASTNode';
import { Environment } from '@/bash/runtime/Environment';
import { expandWord, expandWords, BashRuntimeError, evaluateArithmetic } from '@/bash/runtime/Expansion';
import {
  ExitSignal, ReturnSignal, BreakSignal, ContinueSignal,
} from '@/bash/errors/BashError';
import { isBuiltin, executeBuiltin } from '@/bash/runtime/Builtins';
import { AliasTable } from '@/bash/runtime/AliasTable';
import { BashLexer } from '@/bash/lexer/BashLexer';
import { BashParser } from '@/bash/parser/BashParser';

/** Result from executing an external command. */
export interface ExternalCommandResult {
  output: string;
  exitCode: number;
}

/**
 * Callback type for executing external (non-builtin) commands.
 *
 * `env` carries a snapshot of the shell environment at dispatch time
 * (exported variables plus any per-command `VAR=val` prefix assignments)
 * so external commands such as `ssh` can honour environment forwarding.
 */
export type ExternalCommandFn = (
  argv: string[],
  env?: Record<string, string>,
) => ExternalCommandResult | string;

/** Normalize an external command result to the standard format. */
function normalizeResult(result: ExternalCommandResult | string): ExternalCommandResult {
  if (typeof result === 'string') return { output: result, exitCode: 0 };
  return result;
}

function ensureTrailingNewline(s: string): string {
  return s.length === 0 || s.endsWith('\n') ? s : s + '\n';
}

/** IO context for file redirections. */
export interface IOContext {
  writeFile(path: string, content: string, append: boolean): void;
  readFile(path: string): string | null;
  /** Resolve a path relative to cwd. */
  resolvePath(path: string): string;
  /** Check if a path exists and its type. Returns null if not found. */
  stat?(path: string): { type: 'file' | 'directory' } | null;
  /**
   * Expand a shell glob (`*`, `?`, `[…]`) against the live filesystem.
   * Returns the matched paths, or `null` to indicate the host could not
   * resolve the pattern (the interpreter then falls back to the literal,
   * matching bash's `nullglob`-off default).
   */
  globExpand?(pattern: string, cwd: string): string[] | null;
  /** Resolve the home directory of `user`; `null` means the user is unknown. */
  homeFor?(user: string): string | null;
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
}

export class BashInterpreter {
  env: Environment;
  private executeCommand: ExternalCommandFn;
  private io: IOContext | null;
  private output: string[] = [];
  private functions: Map<string, Command>;
  /** Command aliases — shared with the owning shell when one is passed. */
  readonly aliases: AliasTable;

  constructor(options: InterpreterOptions) {
    this.executeCommand = options.executeCommand;
    this.io = options.io ?? null;
    this.aliases = options.aliases ?? new AliasTable();
    this.functions = options.functions ?? new Map();
    this.env = new Environment({
      variables: options.variables,
      scriptName: options.scriptName ?? 'bash',
      positionalArgs: options.positionalArgs,
      pid: options.pid,
      ppid: options.ppid,
      initialExitCode: options.initialExitCode,
    });
  }

  // ─── Public API ───────────────────────────────────────────────

  /**
   * Execute a command string for command substitution ($(...)).
   * Parses and runs through the full interpreter pipeline in the current env.
   */
  /**
   * Build the per-call glob expander. Returns `undefined` when the host
   * provides no filesystem (e.g. pure-AST tests) so `expandWords` keeps
   * the literal pattern.
   */
  private makeGlobFn(): import('@/bash/runtime/Expansion').GlobFn | undefined {
    if (!this.io?.globExpand) return undefined;
    const expand = this.io.globExpand.bind(this.io);
    return (pattern: string) => {
      const cwd = this.env.get('PWD') ?? '/';
      try { return expand(pattern, cwd); }
      catch { return null; }
    };
  }

  /** Tilde-expander bound to the host's user database (or null). */
  private homeFor(): import('@/bash/runtime/Expansion').HomeForFn | undefined {
    if (!this.io?.homeFor) return undefined;
    const lookup = this.io.homeFor.bind(this.io);
    return (user) => { try { return lookup(user); } catch { return null; } };
  }

  executeSubcommand(cmd: string): string {
    try {
      const lexer = new BashLexer();
      const parser = new BashParser();
      const tokens = lexer.tokenize(cmd);
      const ast = parser.parse(tokens);
      const savedOutput = this.output;
      this.output = [];
      this.visitCommandList(ast.body);
      const result = this.output.join('');
      this.output = savedOutput;
      return result;
    } catch {
      // Fallback to simple external command execution
      return normalizeResult(this.executeCommand(cmd.split(/\s+/))).output;
    }
  }

  /** Execute a Program AST. Returns combined output and exit code. */
  execute(program: Program): { output: string; exitCode: number } {
    this.output = [];
    try {
      this.visitCommandList(program.body);
    } catch (e) {
      if (e instanceof ExitSignal) {
        this.env.lastExitCode = e.exitCode;
      } else if (e instanceof BashRuntimeError) {
        this.output.push(`bash: ${e.message}\n`);
        this.env.lastExitCode = 1;
      } else {
        this.fireExitTrap();
        throw e;
      }
    }
    this.fireExitTrap();
    return { output: this.output.join(''), exitCode: this.env.lastExitCode };
  }

  /** Run the EXIT trap (if any), preserving the parent script's exit code. */
  private fireExitTrap(): void {
    const handler = this.env.getTrap('EXIT');
    if (!handler) return;
    this.env.clearTrap('EXIT');                              // prevent re-entry
    const savedExit = this.env.lastExitCode;
    try { this.executeEval(handler); } catch { /* swallow — trap must not abort cleanup */ }
    this.env.lastExitCode = savedExit;
  }

  // ─── Visitors ─────────────────────────────────────────────────

  /** Counter for contexts that suppress `errexit` (if/while/until heads, &&/|| LHS, `!`). */
  private errexitSuppress = 0;

  /** True when `set -e` is active. */
  private isErrExit(): boolean {
    return (this.env.get('SHELLOPTS') ?? '').split(':').includes('errexit');
  }
  /** True when `set -o pipefail` is active. */
  private isPipefail(): boolean {
    return (this.env.get('SHELLOPTS') ?? '').split(':').includes('pipefail');
  }
  /** True when `set -u` (nounset) is active — consulted by expansion. */
  isNounset(): boolean {
    return (this.env.get('SHELLOPTS') ?? '').split(':').includes('nounset');
  }

  private visitCommandList(node: CommandList): void {
    for (const andOr of node.commands) {
      this.visitAndOrList(andOr);
      if (this.errexitSuppress === 0 && this.isErrExit() && this.env.lastExitCode !== 0) {
        throw new ExitSignal(this.env.lastExitCode);
      }
    }
  }

  private visitAndOrList(node: AndOrList): void {
    // `set -e` is suppressed for every stage EXCEPT the last in an
    // and-or chain (bash semantics: `cmd1 && cmd2` aborts on cmd2's
    // failure, never on cmd1's, because cmd1 is itself a guard).
    const hasRest = node.rest.length > 0;
    if (hasRest) this.errexitSuppress++;
    try {
      this.visitPipeline(node.first);
      for (let i = 0; i < node.rest.length; i++) {
        const part = node.rest[i];
        const isLast = i === node.rest.length - 1;
        if (part.operator === '&&' && this.env.lastExitCode !== 0) continue;
        if (part.operator === '||' && this.env.lastExitCode === 0) continue;
        if (isLast) this.errexitSuppress--;
        this.visitPipeline(part.pipeline);
        if (isLast) this.errexitSuppress++;
      }
    } finally {
      if (hasRest) this.errexitSuppress--;
    }
  }

  private visitPipeline(node: Pipeline): void {
    if (node.commands.length === 1) {
      this.visitCommand(node.commands[0]);
      if (node.negated) this.env.lastExitCode = this.env.lastExitCode === 0 ? 1 : 0;
      return;
    }

    // Multi-stage pipeline: chain stdout → stdin (simplified: pass output as arg)
    const stageCodes: number[] = [];
    let pipeInput = '';
    for (let i = 0; i < node.commands.length; i++) {
      const cmd = node.commands[i];
      const savedOutput = this.output;
      this.output = [];

      // Every stage except the last is itself a guard — its failure
      // must NOT trigger errexit, only the final stage's (or, with
      // pipefail, the aggregate) does.
      const isLast = i === node.commands.length - 1;
      if (!isLast) this.errexitSuppress++;
      try {
        if (cmd.type === 'SimpleCommand' && pipeInput) {
          this.visitSimpleCommandWithInput(cmd, pipeInput);
        } else {
          this.visitCommand(cmd);
        }
      } finally {
        if (!isLast) this.errexitSuppress--;
      }
      stageCodes.push(this.env.lastExitCode);

      pipeInput = this.output.join('');
      this.output = savedOutput;
    }
    // Final stage output goes to real output
    if (pipeInput) this.output.push(pipeInput);
    if (this.isPipefail()) {
      const nonZero = stageCodes.filter(c => c !== 0);
      this.env.lastExitCode = nonZero.length > 0 ? nonZero[nonZero.length - 1] : 0;
    }
    if (node.negated) this.env.lastExitCode = this.env.lastExitCode === 0 ? 1 : 0;
  }

  private visitCommand(node: Command): void {
    switch (node.type) {
      case 'SimpleCommand': this.visitSimpleCommand(node); break;
      case 'IfClause': this.visitIf(node); break;
      case 'ForClause': this.visitFor(node); break;
      case 'WhileClause': this.visitWhile(node); break;
      case 'UntilClause': this.visitUntil(node); break;
      case 'CaseClause': this.visitCase(node); break;
      case 'FunctionDef': this.visitFunctionDef(node); break;
      case 'BraceGroup': this.visitBraceGroup(node); break;
      case 'Subshell': this.visitSubshell(node); break;
      case 'DoubleBracket': this.visitDoubleBracket(node); break;
      case 'ArithmeticCommand': this.visitArithmeticCommand(node); break;
      case 'CStyleForClause': this.visitCStyleFor(node); break;
    }
  }

  // ─── Simple Command ───────────────────────────────────────────

  private visitSimpleCommand(node: SimpleCommand): void {
    this.visitSimpleCommandWithInput(node, '');
  }

  private visitSimpleCommandWithInput(node: SimpleCommand, pipeInput: string): void {
    const cmdExec = (cmd: string) => this.executeSubcommand(cmd);

    // Check for input redirection (< file), herestring (<<<), or heredoc (<<)
    if (!pipeInput) {
      for (const redir of node.redirections) {
        if (redir.op === '<' && this.io) {
          const target = expandWord(redir.target, this.env, cmdExec);
          const path = this.io.resolvePath(target);
          const content = this.io.readFile(path);
          if (content !== null) pipeInput = content;
        } else if (redir.op === '<<<') {
          // Herestring: target word is the stdin content
          pipeInput = expandWord(redir.target, this.env, cmdExec) + '\n';
        } else if (redir.op === '<<') {
          // Heredoc: target word is the body content (from preprocessing)
          pipeInput = expandWord(redir.target, this.env, cmdExec) + '\n';
        }
      }
    }

    // Pre-pass: if this is a declaration command (`local`, `declare`,
    // `typeset`, `readonly`, `export`) called inside a function scope,
    // its trailing `name=value` arguments confine writes to the local
    // scope — bash's `local` semantics. We compute the head word once
    // (cheap literal check) and have `applyAssignment` skip the
    // parent-walk by declaring each name local first.
    const headWord = node.words[0];
    const headName = headWord && headWord.type === 'LiteralWord' ? headWord.value : '';
    const declScope = isDeclScopingCommand(headName);
    const markReadonly = headName === 'readonly';
    const markExport = headName === 'export';

    const absorbedDecl = node.assignments.length > 0 && (declScope || markReadonly || markExport);
    for (const assign of node.assignments) {
      try {
        if (declScope) this.env.declareLocal(assign.name);
        this.applyAssignment(assign, cmdExec);
        if (markReadonly) this.env.setReadonly(assign.name);
        if (markExport) this.env.export(assign.name);
      } catch (e) {
        if (e instanceof Error) this.output.push(e.message + '\n');
        this.env.lastExitCode = 1;
        return;
      }
    }
    if (absorbedDecl && node.words.length === 1) {
      this.env.lastExitCode = 0;
      return;
    }

    // If only assignments, no command to run
    if (node.words.length === 0) {
      this.env.lastExitCode = 0;
      return;
    }

    // Command-position alias expansion happens before any resolution.
    const args = this.expandAliases(expandWords(node.words, this.env, cmdExec, this.makeGlobFn(), this.homeFor()));
    const cmdName = args[0];

    // Handle eval: re-parse and execute the joined args
    if (cmdName === 'eval') {
      this.executeEval(args.slice(1).join(' '));
      return;
    }

    // Handle source/.: read file and execute in current environment
    if ((cmdName === 'source' || cmdName === '.') && args.length > 1) {
      this.executeSource(args[1]);
      return;
    }

    // Capture output for possible redirection (stdout, stderr, or both)
    const hasAnyRedirect = node.redirections.some(r =>
      r.op === '>' || r.op === '>>' || r.op === '>&' || r.fd === 2);
    const savedOutput = hasAnyRedirect ? this.output : null;
    if (hasAnyRedirect) this.output = [];

    // Check for function
    const fn = this.functions.get(cmdName);
    if (cmdName === 'command') {
      // `command` runs its operand skipping function and alias lookup.
      this.runCommandWord(args.slice(1), pipeInput);
    } else if (fn) {
      this.callFunction(fn, args.slice(1));
    } else if (isBuiltin(cmdName)) {
      const result = executeBuiltin(cmdName, args.slice(1), this.env, this.functions, this.io ?? undefined, pipeInput, this.aliases);
      if (result.output) this.output.push(result.output);
      this.env.lastExitCode = result.exitCode;
    } else {
      try {
        const fullArgs = pipeInput ? [...args, pipeInput] : args;
        const envSnapshot = Object.fromEntries(this.env.getAll());
        const result = normalizeResult(this.executeCommand(fullArgs, envSnapshot));
        if (result.output) {
          // Verbatim on redirect (binary-safe); add trailing newline only when going to the terminal.
          this.output.push(hasAnyRedirect ? result.output : ensureTrailingNewline(result.output));
        }
        this.env.lastExitCode = result.exitCode;
      } catch {
        this.env.lastExitCode = 127;
      }
    }

    // Apply output redirections
    if (hasAnyRedirect && savedOutput !== null) {
      const capturedOutput = this.output.join('');
      this.output = savedOutput;
      this.applyRedirections(node.redirections, capturedOutput, cmdExec);
    }
  }

  /**
   * Command-position alias expansion. Substitutes the first word with its
   * alias body, repeating while the new head is itself an alias — but
   * never re-expanding a name already seen, so `alias ls='ls -p'`
   * terminates instead of looping forever.
   */
  private expandAliases(args: string[]): string[] {
    if (args.length === 0 || this.aliases.size === 0) return args;
    let result = args;
    const seen = new Set<string>();
    while (result.length > 0) {
      const head = result[0];
      if (seen.has(head)) break;
      const alias = this.aliases.get(head);
      if (!alias) break;
      seen.add(head);
      result = [...alias.tokens(), ...result.slice(1)];
    }
    return result;
  }

  /**
   * The `command` builtin: run an operand skipping function and alias
   * lookup, or — with `-v` / `-V` — describe how it would resolve.
   */
  /**
   * Realise an Assignment node against the live environment. Handles
   * every Bash assignment form: scalar `VAR=val`, scalar append
   * `VAR+=val`, array literal `arr=(a b c)`, and array append
   * `arr+=(d e)`. The append variants concatenate strings / extend
   * arrays rather than replacing them.
   */
  private applyAssignment(
    assign: import('@/bash/parser/ASTNode').Assignment,
    cmdExec: (cmd: string) => string,
  ): void {
    // Array literal — `name=(elem …)` or `name+=(elem …)`.
    // When `subscript` is present the body is treated as an associative
    // initializer (each elem must look like `[key]=value`).
    if (assign.arrayElements !== undefined) {
      const elems = expandWords(assign.arrayElements, this.env, cmdExec, this.makeGlobFn(), this.homeFor());
      const looksAssoc = elems.every(e => /^\[[^\]]+\]=/.test(e));
      if (this.env.isAssoc(assign.name) || (looksAssoc && elems.length > 0)) {
        if (!assign.append) {
          // Replace the map by re-declaring (clears existing entries).
          this.env.unset(assign.name);
          this.env.declareAssoc(assign.name);
        }
        for (const e of elems) {
          const m = e.match(/^\[([^\]]+)\]=(.*)$/);
          if (m) this.env.setAssocElement(assign.name, m[1], m[2]);
        }
        return;
      }
      if (assign.append) this.env.appendArray(assign.name, elems);
      else this.env.setArray(assign.name, elems);
      return;
    }
    // Element assignment — `name[subscript]=value` (indexed or assoc).
    if (assign.subscript !== undefined) {
      const valueWord = assign.value ? expandWord(assign.value, this.env, cmdExec, this.homeFor()) : '';
      // Substitute simple `$name` / `${name}` refs inside the subscript
      // so `m[$k]=v` works without re-running the full expansion pipeline.
      const key = assign.subscript.replace(/\$\{?([A-Za-z_][A-Za-z_0-9]*)\}?/g,
        (_, n) => this.env.get(n) ?? '');
      if (this.env.isAssoc(assign.name)) {
        const prev = assign.append ? (this.env.getAssocElement(assign.name, key) ?? '') : '';
        this.env.setAssocElement(assign.name, key, prev + valueWord);
        return;
      }
      const idx = Number.parseInt(key, 10);
      const current = this.env.getArray(assign.name) ?? [];
      const next = [...current];
      while (next.length <= idx) next.push('');
      next[idx] = assign.append ? (next[idx] ?? '') + valueWord : valueWord;
      this.env.setArray(assign.name, next);
      return;
    }
    // Scalar — `name=value` or `name+=value`
    const value = assign.value ? expandWord(assign.value, this.env, cmdExec, this.homeFor()) : '';
    if (assign.append) {
      const existing = this.env.get(assign.name) ?? '';
      this.env.set(assign.name, existing + value);
    } else {
      this.env.set(assign.name, value);
    }
  }

  private runCommandWord(rest: string[], pipeInput?: string): void {
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
      const desc = this.describeResolution(name, mode === 'V');
      if (desc !== null) {
        this.output.push(desc + '\n');
        this.env.lastExitCode = 0;
      } else {
        if (mode === 'V') this.output.push(`bash: command: ${name}: not found\n`);
        this.env.lastExitCode = 1;
      }
      return;
    }

    // Execute, skipping function and alias resolution.
    if (isBuiltin(name)) {
      const r = executeBuiltin(
        name, target.slice(1), this.env, this.functions,
        this.io ?? undefined, pipeInput, this.aliases,
      );
      if (r.output) this.output.push(r.output);
      this.env.lastExitCode = r.exitCode;
      return;
    }
    try {
      const fullArgs = pipeInput ? [...target, pipeInput] : target;
      const envSnapshot = Object.fromEntries(this.env.getAll());
      const result = normalizeResult(this.executeCommand(fullArgs, envSnapshot));
      if (result.output) this.output.push(result.output);
      this.env.lastExitCode = result.exitCode;
    } catch {
      this.env.lastExitCode = 127;
    }
  }

  /**
   * Describe how `name` resolves for `command -v` (terse) / `-V`
   * (verbose). Builtins and functions are answered here; any other name
   * is probed against the external executor, which owns the command
   * registry and the VFS.
   */
  private describeResolution(name: string, verbose: boolean): string | null {
    if (isBuiltin(name)) {
      return verbose ? `${name} is a shell builtin` : name;
    }
    if (this.functions.has(name)) {
      return verbose ? `${name} is a function` : name;
    }
    try {
      const probe = normalizeResult(
        this.executeCommand(['command', verbose ? '-V' : '-v', name]),
      );
      const text = probe.output.trim();
      if (probe.exitCode === 0 && text) return text;
    } catch { /* fall through to "not found" */ }
    return null;
  }

  /** Apply output redirections to captured output. */
  private applyRedirections(
    redirections: import('@/bash/parser/ASTNode').Redirection[],
    capturedOutput: string,
    cmdExec: (cmd: string) => string,
  ): void {
    if (!this.io) {
      if (capturedOutput) this.output.push(capturedOutput);
      return;
    }

    let stdoutHandled = false;
    let stderrHandled = false;
    const isError = this.env.lastExitCode !== 0;

    for (const redir of redirections) {
      const target = expandWord(redir.target, this.env, cmdExec);
      const path = this.io.resolvePath(target);
      const append = redir.op === '>>' || redir.op === '&>>';

      try {
        if (redir.op === '>&') {
          // `N>&M` duplicates fd N onto fd M. Numeric target → fd merge
          // (e.g. `2>&1` keeps everything on stdout); only treat as a
          // file-write if the target is not a digit.
          if (/^\d+$/.test(target)) {
            // Merge — output stays captured and flows to stdout below.
            stderrHandled = true;
          } else {
            this.io.writeFile(path, capturedOutput, false);
            stdoutHandled = true;
            stderrHandled = true;
          }
        } else if (redir.op === '>' || redir.op === '>>') {
          const fd = redir.fd ?? 1;
          if (fd === 1) {
            if (isError) {
              this.io.writeFile(path, '', append);
            } else {
              this.io.writeFile(path, capturedOutput, append);
            }
            stdoutHandled = true;
          } else if (fd === 2) {
            if (isError) {
              this.io.writeFile(path, capturedOutput, append);
            }
            stderrHandled = true;
          }
        }
      } catch (e) {
        // Permission denied, Is a directory, etc.
        if (e instanceof Error) this.output.push(e.message + '\n');
        this.env.lastExitCode = 1;
        return;
      }
    }

    // Output not captured by any redirect goes to stdout
    if (!stdoutHandled && !stderrHandled && capturedOutput) {
      this.output.push(capturedOutput);
    } else if (!stdoutHandled && stderrHandled && !isError && capturedOutput) {
      // stdout wasn't redirected but stderr was — show stdout
      this.output.push(capturedOutput);
    } else if (stdoutHandled && !stderrHandled && isError && capturedOutput) {
      // stderr wasn't redirected but stdout was — show stderr
      this.output.push(capturedOutput);
    }
  }

  // ─── If ───────────────────────────────────────────────────────

  private visitIf(node: IfClause): void {
    this.errexitSuppress++;
    try { this.visitCommandList(node.condition); }
    finally { this.errexitSuppress--; }
    if (this.env.lastExitCode === 0) {
      this.visitCommandList(node.thenBody);
      return;
    }

    for (const elif of node.elifClauses) {
      this.errexitSuppress++;
      try { this.visitCommandList(elif.condition); }
      finally { this.errexitSuppress--; }
      if (this.env.lastExitCode === 0) {
        this.visitCommandList(elif.body);
        return;
      }
    }

    if (node.elseBody) {
      this.visitCommandList(node.elseBody);
    }
  }

  // ─── For ──────────────────────────────────────────────────────

  private visitFor(node: ForClause): void {
    const cmdExec = (cmd: string) => this.executeSubcommand(cmd);
    const items = node.words
      ? expandWords(node.words, this.env, cmdExec, this.makeGlobFn(), this.homeFor())
      : this.env.getPositionalArgs();

    for (const item of items) {
      this.env.set(node.variable, item);
      try {
        this.visitCommandList(node.body);
      } catch (e) {
        if (e instanceof BreakSignal) {
          if (e.levels > 1) throw new BreakSignal(e.levels - 1);
          break;
        }
        if (e instanceof ContinueSignal) {
          if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
          continue;
        }
        throw e;
      }
    }
  }

  // ─── While ────────────────────────────────────────────────────

  private visitWhile(node: WhileClause): void {
    const MAX_ITERATIONS = 10000;
    let iterations = 0;
    while (iterations++ < MAX_ITERATIONS) {
      this.errexitSuppress++;
      try { this.visitCommandList(node.condition); }
      finally { this.errexitSuppress--; }
      if (this.env.lastExitCode !== 0) break;
      try {
        this.visitCommandList(node.body);
      } catch (e) {
        if (e instanceof BreakSignal) {
          if (e.levels > 1) throw new BreakSignal(e.levels - 1);
          break;
        }
        if (e instanceof ContinueSignal) {
          if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
          continue;
        }
        throw e;
      }
    }
  }

  // ─── Until ────────────────────────────────────────────────────

  private visitUntil(node: UntilClause): void {
    const MAX_ITERATIONS = 10000;
    let iterations = 0;
    while (iterations++ < MAX_ITERATIONS) {
      this.errexitSuppress++;
      try { this.visitCommandList(node.condition); }
      finally { this.errexitSuppress--; }
      if (this.env.lastExitCode === 0) break;
      try {
        this.visitCommandList(node.body);
      } catch (e) {
        if (e instanceof BreakSignal) {
          if (e.levels > 1) throw new BreakSignal(e.levels - 1);
          break;
        }
        if (e instanceof ContinueSignal) {
          if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
          continue;
        }
        throw e;
      }
    }
  }

  // ─── Case ─────────────────────────────────────────────────────

  private visitCase(node: CaseClause): void {
    const cmdExec = (cmd: string) => this.executeSubcommand(cmd);
    const value = expandWord(node.word, this.env, cmdExec);

    for (const item of node.items) {
      for (const pattern of item.patterns) {
        const pat = expandWord(pattern, this.env, cmdExec);
        if (matchGlob(pat, value)) {
          if (item.body) this.visitCommandList(item.body);
          return; // only first matching case
        }
      }
    }
  }

  // ─── Function Definition ──────────────────────────────────────

  private visitFunctionDef(node: FunctionDef): void {
    this.functions.set(node.name, node.body);
    this.env.lastExitCode = 0;
  }

  private callFunction(body: Command, args: string[]): void {
    // Create a child environment for function scope (supports `local`)
    const savedEnv = this.env;
    const childEnv = this.env.createChild();
    this.env = childEnv;
    this.env.setPositionalArgs(args);
    try {
      this.visitCommand(body);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        this.env.lastExitCode = e.exitCode;
      } else {
        throw e;
      }
    } finally {
      savedEnv.lastExitCode = this.env.lastExitCode;
      this.env = savedEnv;
    }
  }

  // ─── Eval ─────────────────────────────────────────────────────

  private executeEval(code: string): void {
    try {
      const lexer = new BashLexer();
      const parser = new BashParser();
      const tokens = lexer.tokenize(code);
      const ast = parser.parse(tokens);
      this.visitCommandList(ast.body);
    } catch (e) {
      if (e instanceof ExitSignal || e instanceof ReturnSignal ||
          e instanceof BreakSignal || e instanceof ContinueSignal) {
        throw e;
      }
      this.env.lastExitCode = 1;
    }
  }

  // ─── Source ───────────────────────────────────────────────────

  private executeSource(filePath: string): void {
    if (!this.io) {
      this.env.lastExitCode = 1;
      return;
    }
    const path = this.io.resolvePath(filePath);
    const content = this.io.readFile(path);
    if (content === null) {
      this.output.push(`bash: source: ${filePath}: No such file or directory\n`);
      this.env.lastExitCode = 1;
      return;
    }
    this.executeEval(content);
  }

  // ─── Brace Group & Subshell ───────────────────────────────────

  private visitBraceGroup(node: BraceGroup): void {
    const hasRedirect = node.redirections && node.redirections.some(r =>
      r.op === '>' || r.op === '>>' || r.op === '>&');
    if (hasRedirect && this.io) {
      const savedOutput = this.output;
      this.output = [];
      this.visitCommandList(node.body);
      const captured = this.output.join('');
      this.output = savedOutput;
      const cmdExec = (cmd: string) => this.executeSubcommand(cmd);
      this.applyRedirections(node.redirections, captured, cmdExec);
    } else {
      this.visitCommandList(node.body);
    }
  }

  private visitSubshell(node: Subshell): void {
    // Subshell forks an isolated snapshot — writes never leak back.
    const savedEnv = this.env;
    const childEnv = this.env.createSubshell();
    this.env = childEnv;
    try {
      this.visitCommandList(node.body);
    } finally {
      this.env = savedEnv;
      savedEnv.lastExitCode = childEnv.lastExitCode;
    }
  }

  // ─── [[ … ]] Extended Test ────────────────────────────────────

  private visitDoubleBracket(node: DoubleBracket): void {
    const value = this.evalDB(node.expr);
    this.env.lastExitCode = value ? 0 : 1;
  }

  /** Recursive evaluator for the `[[ … ]]` expression tree. */
  private evalDB(expr: DBExpr): boolean {
    const cmdExec = (cmd: string) => this.executeSubcommand(cmd);
    switch (expr.kind) {
      case 'or':  return this.evalDB(expr.left) || this.evalDB(expr.right);
      case 'and': return this.evalDB(expr.left) && this.evalDB(expr.right);
      case 'not': return !this.evalDB(expr.expr);
      case 'lit': return expandWord(expr.word, this.env, cmdExec) !== '';
      case 'unary': {
        const v = expandWord(expr.arg, this.env, cmdExec);
        return this.dbUnary(expr.op, v);
      }
      case 'binary': {
        const lhs = expandWord(expr.lhs, this.env, cmdExec);
        const rhs = expandWord(expr.rhs, this.env, cmdExec);
        return this.dbBinary(expr.op, lhs, rhs, expr.rhs);
      }
    }
  }

  private dbUnary(op: string, v: string): boolean {
    switch (op) {
      case '-n': return v.length > 0;
      case '-z': return v.length === 0;
      case '-v': return this.env.isSet(v);
    }
    // File tests — delegate to the IOContext stat hook.
    const stat = this.io?.stat;
    if (!stat) return false;
    const abs = this.io?.resolvePath?.(v) ?? v;
    const st = stat(abs);
    switch (op) {
      case '-e':
      case '-a': return !!st;
      case '-f': return st?.type === 'file';
      case '-d': return st?.type === 'directory';
      default:  return false;          // -b/-c/-p/-S/-r/-w/-x/-O/-G/-N/-t/-u/-g/-k → unsupported in plain IOContext
    }
  }

  private dbBinary(op: string, lhs: string, rhs: string, rhsWord: Word): boolean {
    switch (op) {
      case '=':
      case '==': return globMatch(rhs, lhs);
      case '!=': return !globMatch(rhs, lhs);
      case '=~': return this.regexMatch(lhs, rhs, rhsWord);
      case '<':  return lhs < rhs;
      case '>':  return lhs > rhs;
      case '-eq': return Number.parseInt(lhs, 10) === Number.parseInt(rhs, 10);
      case '-ne': return Number.parseInt(lhs, 10) !== Number.parseInt(rhs, 10);
      case '-lt': return Number.parseInt(lhs, 10) <   Number.parseInt(rhs, 10);
      case '-le': return Number.parseInt(lhs, 10) <=  Number.parseInt(rhs, 10);
      case '-gt': return Number.parseInt(lhs, 10) >   Number.parseInt(rhs, 10);
      case '-ge': return Number.parseInt(lhs, 10) >=  Number.parseInt(rhs, 10);
    }
    return false;
  }

  /**
   * `=~` matches LHS against RHS as an ERE. Bash treats unquoted RHS
   * as a regex and quoted RHS as a literal; we approximate via the
   * Word AST (LiteralWord → regex, quoted forms → literal).
   */
  private regexMatch(value: string, pattern: string, patternWord: Word): boolean {
    const literal = patternWord.type === 'SingleQuotedWord' || patternWord.type === 'DoubleQuotedWord';
    try {
      const re = new RegExp(literal ? escapeRegex(pattern) : pattern);
      return re.test(value);
    } catch {
      return false;
    }
  }

  // ─── (( arithmetic command )) ────────────────────────────────

  private visitArithmeticCommand(node: ArithmeticCommand): void {
    const result = evaluateArithmetic(node.expression, this.env);
    // Bash: exit 0 iff the arithmetic result is non-zero.
    this.env.lastExitCode = Number.parseInt(result, 10) !== 0 ? 0 : 1;
  }

  // ─── for ((init; cond; update)) ──────────────────────────────

  private visitCStyleFor(node: CStyleForClause): void {
    const MAX = 100_000;
    if (node.init) evaluateArithmetic(node.init, this.env);
    let iters = 0;
    while (iters++ < MAX) {
      if (node.cond) {
        const v = evaluateArithmetic(node.cond, this.env);
        if (Number.parseInt(v, 10) === 0) break;
      }
      try {
        this.visitCommandList(node.body);
      } catch (e) {
        if (e instanceof BreakSignal) {
          if (e.levels > 1) throw new BreakSignal(e.levels - 1);
          break;
        }
        if (e instanceof ContinueSignal) {
          if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
        } else { throw e; }
      }
      if (node.update) evaluateArithmetic(node.update, this.env);
    }
  }
}

/** Glob-style match used by `[[ … ]]`'s `==` / `!=`. */
/**
 * True for the bash "declaration commands" that confine `name=value`
 * arguments to the local scope. `readonly` and `export` are NOT in
 * this list — they keep the parent-walking semantics.
 */
function isDeclScopingCommand(name: string): boolean {
  return name === 'local' || name === 'declare' || name === 'typeset';
}

function globMatch(pattern: string, value: string): boolean {
  // Convert the glob to a regex anchored on both ends.
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) { src += escapeRegex(pattern[++i]); continue; }
    if (c === '*') { src += '.*'; continue; }
    if (c === '?') { src += '.';  continue; }
    if (c === '[') {
      let cls = '[';
      i++;
      if (pattern[i] === '!' || pattern[i] === '^') { cls += '^'; i++; }
      while (i < pattern.length && pattern[i] !== ']') { cls += pattern[i]; i++; }
      cls += ']';
      src += cls;
      continue;
    }
    src += escapeRegex(c);
  }
  try { return new RegExp('^' + src + '$').test(value); }
  catch { return pattern === value; }
}

function escapeRegex(s: string): string {
  return s.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
}

// ─── Glob Matching (for case patterns) ─────────────────────────

/** Simple glob match: supports *, ?, and character classes [abc]. */
export function matchGlob(pattern: string, text: string): boolean {
  let pi = 0, ti = 0;
  let starPi = -1, starTi = -1;

  while (ti < text.length) {
    if (pi < pattern.length && (pattern[pi] === text[ti] || pattern[pi] === '?')) {
      pi++; ti++;
    } else if (pi < pattern.length && pattern[pi] === '*') {
      starPi = pi; starTi = ti;
      pi++;
    } else if (starPi >= 0) {
      pi = starPi + 1;
      starTi++;
      ti = starTi;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === '*') pi++;
  return pi === pattern.length;
}
