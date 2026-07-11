import { ITokenizer, Lexer } from "./ast/lexer";
import { Parser } from "./ast/parser";
import { IExpander } from "./ast/expander";
import { ExitCode } from "./command/types";
import { Executor } from "./exec/executor";
import { PermissionGuard } from "./exec/permission-guard";
import { CommandIO } from "./io/types";
import { MachineApi } from "./machine/types";
import { CommandRegistry } from "./registry/command-registry";
import { Session } from "./session/types";

export interface InterpreterOptions {
  /** Tokenizer alternatif — pour un vendeur dont la syntaxe diverge trop
   *  du bash (ex: cmd.exe) pour réutiliser le `Lexer` partagé. */
  readonly lexer?: ITokenizer;
  readonly parser?: Parser;
  readonly expander?: IExpander;
  readonly guard?: PermissionGuard;
}

/** Façade publique : source texte -> AST -> exécution. */
export class Interpreter {
  private readonly lexer: ITokenizer;
  private readonly parser: Parser;
  private readonly executor: Executor;

  constructor(
    private readonly registry: CommandRegistry,
    machine: MachineApi,
    options: InterpreterOptions = {},
  ) {
    this.lexer = options.lexer ?? new Lexer();
    this.parser = options.parser ?? new Parser();
    this.executor = new Executor(registry, machine, options.guard, options.expander);
  }

  /** Une ligne interactive : "ls -l /tmp | grep log && echo ok" */
  async interpretLine(line: string, session: Session, io: CommandIO): Promise<ExitCode> {
    const tokens = this.lexer.tokenize(line);
    const ast = this.parser.parse(tokens);
    return this.executor.run(ast, session, io);
  }

  /** Un script complet, multi-lignes, avec if/for/while/variables. */
  async runScript(source: string, session: Session, io: CommandIO): Promise<ExitCode> {
    return this.interpretLine(source, session, io); // même pipeline lexer→parser→executor
  }

  get commands(): CommandRegistry {
    return this.registry;
  }
}
