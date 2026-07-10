import { ArgumentParser } from "../args/argument-parser";
import { BaseCommand } from "../command/base-command";
import { CommandContext, ExitCode, EXIT_OK } from "../command/types";
import { CommandNotFoundError, ShellError } from "../errors";
import { FileOutputStream } from "../io/file-output-stream";
import { PipeBuffer } from "../io/pipe-buffer";
import { CommandIO, InputStream } from "../io/types";
import { MachineApi } from "../machine/types";
import { CommandRegistry } from "../registry/command-registry";
import { Session } from "../session/types";
import { Expander } from "../ast/expander";
import {
  PipelineNode,
  RedirectionNode,
  ScriptNode,
  SimpleCommandNode,
} from "../ast/nodes";
import { PermissionGuard } from "./permission-guard";

/**
 * Évalue l'AST : dispatch selon le kind du nœud, gère pipes,
 * opérateurs logiques, boucles, conditions et redirections.
 */
export class Executor {
  private readonly argParser = new ArgumentParser();
  private readonly expander = new Expander();

  constructor(
    private readonly registry: CommandRegistry,
    private readonly machine: MachineApi,
    private readonly guard: PermissionGuard = new PermissionGuard(),
  ) {}

  async run(node: ScriptNode, session: Session, io: CommandIO): Promise<ExitCode> {
    switch (node.kind) {
      case "command":
        return this.runSimple(node, session, io);
      case "pipeline":
        return this.runPipeline(node, session, io);
      case "and": {
        const code = await this.run(node.left, session, io);
        return code === EXIT_OK ? this.run(node.right, session, io) : code;
      }
      case "or": {
        const code = await this.run(node.left, session, io);
        return code !== EXIT_OK ? this.run(node.right, session, io) : code;
      }
      case "sequence": {
        let last: ExitCode = EXIT_OK;
        for (const stmt of node.statements) {
          last = await this.run(stmt, session, io);
          session.lastExitCode = last;
        }
        return last;
      }
      case "if": {
        const cond = await this.run(node.condition, session, io);
        if (cond === EXIT_OK) return this.run(node.thenBranch, session, io);
        return node.elseBranch ? this.run(node.elseBranch, session, io) : EXIT_OK;
      }
      case "for": {
        let last: ExitCode = EXIT_OK;
        for (const rawItem of node.items) {
          const [item] = this.expander.expand(rawItem, session);
          session.variables.set(node.variable, item);
          last = await this.run(node.body, session, io);
          session.lastExitCode = last;
        }
        return last;
      }
      case "while": {
        let last: ExitCode = EXIT_OK;
        while ((await this.run(node.condition, session, io)) === EXIT_OK) {
          last = await this.run(node.body, session, io);
          session.lastExitCode = last;
        }
        return last;
      }
      case "assign": {
        const [value] = this.expander.expand(node.value, session);
        session.variables.set(node.name, value);
        session.lastExitCode = EXIT_OK;
        return EXIT_OK;
      }
      case "subshell": {
        const cloned: Session = {
          ...session,
          variables: new Map(session.variables),
          env: new Map(session.env),
        };
        const code = await this.run(node.body, cloned, io);
        // Le sous-shell n'expose PAS ses variables au parent (isolation),
        // mais le code de sortie retourné se propage bien vers l'appelant.
        return code;
      }
    }
  }

  /** Cycle complet d'une commande simple : resolve → guard → parse → execute. */
  private async runSimple(
    node: SimpleCommandNode,
    session: Session,
    io: CommandIO,
  ): Promise<ExitCode> {
    const command = this.registry.resolve(node.name);
    if (!command) throw new CommandNotFoundError(node.name);

    // 1. Expansion des variables/globs sur l'argv brut
    const argv = node.argv.flatMap((w) => this.expander.expand(w, session));

    // 2. Conversion entrée utilisateur -> arguments typés
    const args = this.argParser.parse(argv, command.descriptor);

    // 3. Contrôle des privilèges déclarés PAR la commande
    this.guard.check(command, session.user, args);

    // 4. Redirections éventuelles (> >> <) : on adapte l'IO. `ownedStdout` n'est
    //    défini que si une redirection a créé un flux dédié (fichier) — le
    //    flux d'origine (terminal, pipe de script) reste géré par son
    //    propriétaire et ne doit jamais être fermé ici.
    const { io: effectiveIO, ownedStdout } = await this.applyRedirections(
      node.redirections,
      session,
      io,
    );

    // 5. Exécution avec accès aux méthodes internes de la machine
    const ctx: CommandContext = {
      session,
      io: effectiveIO,
      machine: this.machine,
      args,
      rawArgv: argv,
      signal: new AbortController().signal,
    };
    try {
      const runner =
        command instanceof BaseCommand ? command.run(ctx) : command.execute(ctx);
      const code = await runner;
      session.lastExitCode = code;
      return code;
    } catch (err) {
      if (err instanceof ShellError) {
        await io.stderr.write(`${node.name}: ${err.message}\n`);
        session.lastExitCode = err.exitCode;
        return err.exitCode;
      }
      throw err;
    } finally {
      if (ownedStdout) await ownedStdout.close();
    }
  }

  /** cmd1 | cmd2 : le stdout de l'une devient le stdin de la suivante. */
  private async runPipeline(
    node: PipelineNode,
    session: Session,
    io: CommandIO,
  ): Promise<ExitCode> {
    let previous: InputStream = io.stdin;
    let last: ExitCode = EXIT_OK;
    for (let i = 0; i < node.stages.length; i++) {
      const isLast = i === node.stages.length - 1;
      const pipe = new PipeBuffer();
      last = await this.runSimple(node.stages[i], session, {
        stdin: previous,
        stdout: isLast ? io.stdout : pipe,
        stderr: io.stderr,
      });
      await pipe.close();
      previous = pipe;
    }
    session.lastExitCode = last;
    return last;
  }

  private async applyRedirections(
    redirections: readonly RedirectionNode[],
    session: Session,
    io: CommandIO,
  ): Promise<{ io: CommandIO; ownedStdout?: FileOutputStream }> {
    if (redirections.length === 0) return { io };

    let stdin = io.stdin;
    let stdout = io.stdout;
    let ownedStdout: FileOutputStream | undefined;
    let inPath: string | undefined;
    let outTarget: { path: string; append: boolean } | undefined;

    for (const redirection of redirections) {
      const resolved = this.machine.fs.resolve(session.cwd, redirection.target);
      if (redirection.mode === "in") {
        inPath = resolved;
      } else {
        outTarget = { path: resolved, append: redirection.mode === "append" };
      }
    }

    if (inPath !== undefined) {
      const content = await this.machine.fs.readFile(inPath);
      const buffer = new PipeBuffer();
      await buffer.write(content);
      await buffer.close();
      stdin = buffer;
    }

    if (outTarget !== undefined) {
      ownedStdout = new FileOutputStream(this.machine.fs, outTarget.path, outTarget.append);
      stdout = ownedStdout;
    }

    return { io: { stdin, stdout, stderr: io.stderr }, ownedStdout };
  }
}
