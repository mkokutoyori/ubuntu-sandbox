import { ParsedArgs } from "../args/parsed-args";
import { Session } from "../session/types";
import { CommandContext, CommandDescriptor, ExitCode, ICommand } from "./types";

/**
 * Classe de base optionnelle (Template Method) : offre un hook de
 * validation sémantique post-parsing. Une commande tierce peut aussi
 * implémenter ICommand directement si elle préfère.
 */
export abstract class BaseCommand implements ICommand {
  abstract readonly descriptor: CommandDescriptor;

  /** Validation métier après parsing (ex: cohérence entre options). */
  protected validate(_args: ParsedArgs, _session: Session): void {
    /* no-op par défaut */
  }

  /** Point d'entrée appelé par l'Executor. */
  async run(ctx: CommandContext): Promise<ExitCode> {
    this.validate(ctx.args, ctx.session);
    return this.execute(ctx);
  }

  abstract execute(ctx: CommandContext): Promise<ExitCode>;
}
