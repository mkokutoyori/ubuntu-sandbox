import { Lexer } from "./ast/lexer";
import { Parser } from "./ast/parser";
import { ExitCode } from "./command/types";
import { Executor } from "./exec/executor";
import { CommandIO } from "./io/types";
import { MachineApi } from "./machine/types";
import { CommandRegistry } from "./registry/command-registry";
import { Session } from "./session/types";

/** Façade publique : source texte -> AST -> exécution. */
export class Interpreter {
  private readonly lexer = new Lexer();
  private readonly parser = new Parser();
  private readonly executor: Executor;

  constructor(
    private readonly registry: CommandRegistry,
    machine: MachineApi,
  ) {
    this.executor = new Executor(registry, machine);
  }

  /** Une ligne interactive : "ls -l /tmp | grep log && echo ok" */
  async interpretLine(
    line: string,
    session: Session,
    io: CommandIO,
    signal?: AbortSignal,
  ): Promise<ExitCode> {
    const tokens = this.lexer.tokenize(line);
    const ast = this.parser.parse(tokens);
    return this.executor.run(ast, session, io, signal);
  }

  /** Un script complet, multi-lignes, avec if/for/while/variables. */
  async runScript(
    source: string,
    session: Session,
    io: CommandIO,
    signal?: AbortSignal,
  ): Promise<ExitCode> {
    return this.interpretLine(source, session, io, signal); // même pipeline lexer→parser→executor
  }

  /**
   * Exécute une commande déjà nommée et tokenisée par un pont legacy (un
   * interpréteur de script tiers qui gère lui-même expansion/redirections/
   * boucles) — sans repasser par le Lexer/Parser du socle. `null` si `name`
   * n'est pas enregistrée : c'est TOUJOURS cet `Interpreter`, jamais son
   * `Executor`/`CommandRegistry` interne, que l'appelant doit consulter.
   */
  async runResolved(
    name: string,
    argv: readonly string[],
    session: Session,
    io: CommandIO,
    signal?: AbortSignal,
  ): Promise<ExitCode | null> {
    return this.executor.runResolved(name, argv, session, io, signal);
  }

  get commands(): CommandRegistry {
    return this.registry;
  }
}
