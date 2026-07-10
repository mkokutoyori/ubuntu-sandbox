import { BaseCommand } from "../command/base-command";
import { CommandContext, CommandDescriptor, ExitCode } from "../command/types";
import { DefaultPrivilegePolicy } from "../session/privilege-policy";
import { PrivilegeLevel } from "../session/types";

/**
 * Signal de contrôle (pas une erreur métier) : levé par la commande
 * `exit`, traverse l'Executor et est intercepté par le Shell.
 */
export class ExitRequest extends Error {
  constructor(public readonly code: ExitCode = 0) {
    super("exit");
    this.name = "ExitRequest";
  }
}

/** `exit` est une commande comme une autre : enregistrée au registre. */
export class ExitCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: "exit",
    aliases: ["logout"],
    summary: "Termine la session shell",
    usage: "exit [code]",
    args: [
      {
        name: "code",
        type: "int",
        required: false,
        description: "code de sortie de la session",
      },
    ],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: "session",
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    throw new ExitRequest(
      ctx.args.has("code") ? ctx.args.get<number>("code") : ctx.session.lastExitCode,
    );
  }
}
