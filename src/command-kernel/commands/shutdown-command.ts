import { BaseCommand } from "../command/base-command";
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from "../command/types";
import { ParsedArgs } from "../args/parsed-args";
import { UsageError } from "../errors";
import { DefaultPrivilegePolicy } from "../session/privilege-policy";
import { Capability, PrivilegeLevel } from "../session/types";

/** Commande strictement réservée à root : la politique vit DANS la commande. */
export class ShutdownCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: "shutdown",
    aliases: ["poweroff"],
    summary: "Éteint la machine",
    usage: "shutdown [--delay <secondes>]",
    args: [],
    options: [
      {
        long: "delay",
        short: "d",
        takesValue: true,
        type: "int",
        defaultValue: 0,
        description: "délai avant extinction",
      },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ROOT, [], [Capability.SYS_SHUTDOWN]),
    category: "système",
  };

  protected override validate(args: ParsedArgs): void {
    if (args.get<number>("delay") < 0) {
      throw new UsageError("le délai doit être positif");
    }
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const delay = ctx.args.get<number>("delay");
    await ctx.io.stdout.write(`Extinction dans ${delay}s…\n`);
    await ctx.machine.power.shutdown(delay);
    return EXIT_OK;
  }
}
