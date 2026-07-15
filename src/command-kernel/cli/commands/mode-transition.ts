import { BaseCommand } from "../../command/base-command";
import type { CommandContext, CommandDescriptor, ExitCode } from "../../command/types";
import { EXIT_OK } from "../../command/types";
import { DefaultPrivilegePolicy } from "../../session/privilege-policy";
import { PrivilegeLevel } from "../../session/types";
import { endToMode, popMode, pushMode } from "../cli-session";
import type { CliSession } from "../types";

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * Commande primitive de PUSH de mode — utilisée par les vendeurs pour
 * bâtir `enable` (push privileged), `configure terminal` (push config),
 * `interface X` (push config-if avec pré-sélection), etc.
 *
 * Le vendeur instancie une sous-classe qui définit :
 *  - le mode cible ;
 *  - éventuellement, un pré-traitement d'argument (ex: valider et poser
 *    `session.promptFields.set('selectedInterface', ...)` avant push).
 *
 * L'existence du mode cible est validée via `ctx.machine.cli.modes` —
 * pas d'import direct du `ModeRegistry` par la commande.
 */
export abstract class PushModeCommand extends BaseCommand {
  protected abstract targetMode(ctx: CommandContext): string;

  /** Pré-traitement optionnel — validation d'argument, positionnement de
   *  champs du prompt. Retourner `false` pour annuler la transition
   *  (message d'erreur déjà écrit sur `ctx.io.stderr`). */
  protected async prepare(_ctx: CommandContext): Promise<boolean> {
    return true;
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (!ctx.machine.cli) {
      await ctx.io.stderr.write(`${this.descriptor.name}: cet équipement n'a pas de CLI vendeur\n`);
      return 1;
    }
    if (!(await this.prepare(ctx))) return 1;
    const target = this.targetMode(ctx);
    if (!ctx.machine.cli.modes.has(target)) {
      await ctx.io.stderr.write(`${this.descriptor.name}: mode cible inconnu "${target}"\n`);
      return 1;
    }
    pushMode(ctx.session as CliSession, target);
    return EXIT_OK;
  }
}

/**
 * Commande primitive `exit`/`quit` — pop d'un mode. Nettoie les champs
 * `clearOnExit` du mode quitté avant le pop.
 */
export class PopModeCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor;

  constructor(name: string = 'exit', summary = 'Sortir du mode courant') {
    super();
    this.descriptor = {
      name,
      summary,
      usage: name,
      args: [],
      options: [],
      privileges: ANY,
      category: 'cli-mode',
    };
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (!ctx.machine.cli) return EXIT_OK; // pas de CLI = pas de mode à pop, no-op
    const cli = ctx.session as CliSession;
    const current = cli.modeStack[cli.modeStack.length - 1];
    const modeDef = ctx.machine.cli.modes.get(current);
    popMode(cli, modeDef.clearOnExit ?? []);
    return EXIT_OK;
  }
}

/**
 * Commande primitive `end` / Ctrl-Z — retour au mode d'exécution
 * privilégié (`ModeRegistry.execLevel()`), en nettoyant tous les champs
 * `clearOnExit` des modes traversés.
 */
export class EndCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'end',
    summary: 'Retour au mode d\'exécution privilégié',
    usage: 'end',
    args: [],
    options: [],
    privileges: ANY,
    category: 'cli-mode',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (!ctx.machine.cli) return EXIT_OK;
    const cli = ctx.session as CliSession;
    const target = ctx.machine.cli.modes.execLevel().name;
    endToMode(cli, target, (mode) => ctx.machine.cli!.modes.get(mode).clearOnExit ?? []);
    return EXIT_OK;
  }
}
