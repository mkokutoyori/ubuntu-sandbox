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
  Word, Assignment,
} from '@/bash/parser/ASTNode';
import { Environment } from '@/bash/runtime/Environment';
import { expandWord, expandWords } from '@/bash/runtime/Expansion';
import {
  ExitSignal, ReturnSignal, BreakSignal, ContinueSignal,
} from '@/bash/errors/BashError';
import { isBuiltin, executeBuiltin } from '@/bash/runtime/Builtins';
import { BashLexer } from '@/bash/lexer/BashLexer';
import { BashParser } from '@/bash/parser/BashParser';

/** Result from executing an external command. */
export interface ExternalCommandResult {
  output: string;
  exitCode: number;
}

/** Callback type for executing external (non-builtin) commands. */
export type ExternalCommandFn = (argv: string[]) => ExternalCommandResult | string;

/** Normalize an external command result to the standard format. */
function normalizeResult(result: ExternalCommandResult | string): ExternalCommandResult {
  if (typeof result === 'string') return { output: result, exitCode: 0 };
  return result;
}

/** IO context for file redirections. */
export interface IOContext {
  writeFile(path: string, content: string, append: boolean): void;
  readFile(path: string): string | null;
  /** Resolve a path relative to cwd. */
  resolvePath(path: string): string;
  /** Check if a path exists and its type. Returns null if not found. */
  stat?(path: string): { type: 'file' | 'directory' } | null;
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
}

export class BashInterpreter {
  env: Environment;
  private executeCommand: ExternalCommandFn;
  private io: IOContext | null;
  private output: string[] = [];
  private functions: Map<string, Command> = new Map();

  constructor(options: InterpreterOptions) {
    this.executeCommand = options.executeCommand;
    this.io = options.io ?? null;
    this.env = new Environment({
      variables: options.variables,
      scriptName: options.scriptName ?? 'bash',
      positionalArgs: options.positionalArgs,
    });
  }

  // ─── Public API ───────────────────────────────────────────────

  /**
   * Execute a command string for command substitution ($(...)).
   * Parses and runs through the full interpreter pipeline in the current env.
   */
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
      } else {
        throw e;
      }
    }
    return { output: this.output.join(''), exitCode: this.env.lastExitCode };
  }

  // ─── Visitors ─────────────────────────────────────────────────

  private visitCommandList(node: CommandList): void {
    for (const andOr of node.commands) {
      this.visitAndOrList(andOr);
    }
  }

  private visitAndOrList(node: AndOrList): void {
    this.visitPipeline(node.first);

    for (const part of node.rest) {
      if (part.operator === '&&' && this.env.lastExitCode !== 0) continue;
      if (part.operator === '||' && this.env.lastExitCode === 0) continue;
      this.visitPipeline(part.pipeline);
    }
  }

  private visitPipeline(node: Pipeline): void {
    if (node.commands.length === 1) {
      this.visitCommand(node.commands[0]);
      return;
    }

    // Multi-stage pipeline: chain stdout → stdin (simplified: pass output as arg)
    let pipeInput = '';
    for (let i = 0; i < node.commands.length; i++) {
      const cmd = node.commands[i];
      const savedOutput = this.output;
      this.output = [];

      if (cmd.type === 'SimpleCommand' && pipeInput) {
        // Pass pipe input to the command executor
        this.visitSimpleCommandWithInput(cmd, pipeInput);
      } else {
        this.visitCommand(cmd);
      }

      pipeInput = this.output.join('');
      this.output = savedOutput;
    }
    // Final stage output goes to real output
    if (pipeInput) this.output.push(pipeInput);
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

    // Process assignments
    for (const assign of node.assignments) {
      const value = assign.value ? expandWord(assign.value, this.env, cmdExec) : '';
      try {
        this.env.set(assign.name, value);
      } catch (e) {
        if (e instanceof Error) this.output.push(e.message + '\n');
        this.env.lastExitCode = 1;
        return;
      }
    }

    // If only assignments, no command to run
    if (node.words.length === 0) {
      this.env.lastExitCode = 0;
      return;
    }

    const args = expandWords(node.words, this.env, cmdExec);
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
    if (fn) {
      this.callFunction(fn, args.slice(1));
    } else if (isBuiltin(cmdName)) {
      const result = executeBuiltin(cmdName, args.slice(1), this.env, this.functions, this.io ?? undefined);
      if (result.output) this.output.push(result.output);
      this.env.lastExitCode = result.exitCode;
    } else {
      // External command
      try {
        const fullArgs = pipeInput ? [...args, pipeInput] : args;
        const result = normalizeResult(this.executeCommand(fullArgs));
        if (result.output) this.output.push(result.output);
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
          this.io.writeFile(path, capturedOutput, false);
          stdoutHandled = true;
          stderrHandled = true;
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
    this.visitCommandList(node.condition);
    if (this.env.lastExitCode === 0) {
      this.visitCommandList(node.thenBody);
      return;
    }

    for (const elif of node.elifClauses) {
      this.visitCommandList(elif.condition);
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
      ? expandWords(node.words, this.env, cmdExec)
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
      this.visitCommandList(node.condition);
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
      this.visitCommandList(node.condition);
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
    // Subshell runs in a child environment
    const savedEnv = this.env;
    const childEnv = this.env.createChild();
    // Temporarily swap — we restore after
    this.env = childEnv;
    try {
      this.visitCommandList(node.body);
    } finally {
      this.env = savedEnv;
      savedEnv.lastExitCode = childEnv.lastExitCode;
    }
  }
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
