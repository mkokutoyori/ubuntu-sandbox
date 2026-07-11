import { Parser } from '@/command-kernel/ast/parser';
import type { ScriptNode } from '@/command-kernel/ast/nodes';
import { ExitCode } from '@/command-kernel/command/types';
import { Executor } from '@/command-kernel/exec/executor';
import { CommandIO } from '@/command-kernel/io/types';
import { MachineApi } from '@/command-kernel/machine/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { Session } from '@/command-kernel/session/types';
import { CmdExpander } from './ast/CmdExpander';
import { CmdLexer } from './ast/CmdLexer';

/**
 * cmd.exe's own `Lexer → Parser → Executor` facade — dedicated to Windows
 * rather than a parameterised variant of command-kernel's bash
 * `Interpreter` (§0/§4 of migration_framework.md: the engine —
 * `Executor`/`CommandRegistry`/`PermissionGuard`/`ArgumentParser` — is
 * shared and untouched; only the syntax layer is vendor-specific, and it
 * lives entirely here instead of behind generic injection points on the
 * shared classes). `Parser` (`ast/parser.ts`) is reused as-is: it only
 * consumes `Token`/`TokenType`, never bash syntax directly.
 */
export class CmdInterpreter {
  private readonly lexer = new CmdLexer();
  private readonly parser = new Parser();
  private readonly executor: Executor;

  constructor(registry: CommandRegistry, machine: MachineApi) {
    // cmd wildcards (`*.tmp`) have per-command scope and `\` paths — nothing
    // like the generic POSIX glob, so each migrated command matches its own
    // wildcards against `ctx.machine.fs.list()` instead (see DelCommand).
    this.executor = new Executor(registry, machine, undefined, new CmdExpander(), async (word) => [word]);
  }

  parse(line: string): ScriptNode {
    return this.parser.parse(this.lexer.tokenize(line));
  }

  async interpretLine(line: string, session: Session, io: CommandIO): Promise<ExitCode> {
    return this.executor.run(this.parse(line), session, io);
  }

  /** Exécute un AST déjà parsé (évite de re-tokeniser/re-parser une ligne
   *  que l'appelant a dû inspecter avant exécution). */
  async runAst(ast: ScriptNode, session: Session, io: CommandIO): Promise<ExitCode> {
    return this.executor.run(ast, session, io);
  }
}
