import { ExitCode } from "../command/types";
import { ShellError } from "../errors";
import { Interpreter } from "../interpreter";
import { MachineApi } from "../machine/types";
import { Session } from "../session/types";
import { Terminal } from "../terminal/terminal";
import { TerminalEventListener } from "../terminal/types";
import { ExitRequest } from "./exit";
import { History } from "./history";
import { PromptBuilder } from "./prompt-builder";

/**
 * Le Shell relie un Terminal (périphérique) à l'Interpreter (moteur) :
 *  - possède la Session (utilisateur, env, cwd, variables, $?)
 *  - boucle REPL : prompt -> lecture -> historique -> interprétation
 *  - gère Ctrl+C (annulation), EOF (Ctrl+D), erreurs et sortie propre
 * Plusieurs Shell peuvent coexister sur la même machine : un par
 * session/terminal, tous partageant le même CommandRegistry.
 */
export class Shell implements TerminalEventListener {
  readonly history = new History();
  private running = false;
  private currentAbort?: AbortController;

  constructor(
    private readonly terminal: Terminal,
    private readonly interpreter: Interpreter,
    private readonly machine: MachineApi,
    readonly session: Session,
    private readonly prompt: PromptBuilder = new PromptBuilder(),
  ) {
    terminal.subscribe(this);
  }

  /** Ctrl+C : annule la commande en cours sans tuer la session. */
  onInterrupt(): void {
    this.currentAbort?.abort();
  }

  /** Boucle interactive principale ; rend le code de sortie de la session. */
  async start(): Promise<ExitCode> {
    this.running = true;
    await this.terminal.write(`Bienvenue sur ${this.machine.hostname}\n`);
    while (this.running) {
      const ps1 = this.prompt.build(this.session, this.machine.hostname);
      const line = await this.terminal.readLine(ps1);
      if (line === null) {
        // EOF (Ctrl+D)
        this.stop(this.session.lastExitCode);
        break;
      }
      if (!line.trim()) continue;
      this.history.push(line);
      await this.execute(line);
    }
    return this.session.lastExitCode;
  }

  /** Exécute une ligne — utilisable aussi hors REPL (ex: shell -c "…"). */
  async execute(line: string): Promise<ExitCode> {
    this.currentAbort = new AbortController();
    try {
      return await this.interpreter.interpretLine(
        line,
        this.session,
        this.terminal.asCommandIO(),
      );
    } catch (err) {
      if (err instanceof ExitRequest) return this.stop(err.code);
      if (err instanceof ShellError) {
        await this.terminal.writeError(`shell: ${err.message}\n`);
        this.session.lastExitCode = err.exitCode;
        return err.exitCode;
      }
      throw err; // bug interne : on ne masque pas
    } finally {
      this.currentAbort = undefined;
    }
  }

  /** Charge et exécute un fichier script en passant par la machine elle-même. */
  async runScriptFile(path: string): Promise<ExitCode> {
    const resolved = this.machine.fs.resolve(this.session.cwd, path);
    const source = await this.machine.fs.readFile(resolved);
    return this.interpreter.runScript(source, this.session, this.terminal.asCommandIO());
  }

  private stop(code: ExitCode): ExitCode {
    this.running = false;
    this.session.lastExitCode = code;
    return code;
  }
}
