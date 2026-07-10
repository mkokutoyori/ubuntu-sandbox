import { BaseCommand } from "../command/base-command";
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from "../command/types";
import { Capability } from "../session/types";
import { DefaultPrivilegePolicy } from "../session/privilege-policy";
import { PrivilegeLevel } from "../session/types";
import { toFileSystemActor } from "../machine/types";

/** Commande accessible à tous, exigeant seulement la capacité fs.read. */
export class CatCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: "cat",
    summary: "Affiche le contenu d'un ou plusieurs fichiers",
    usage: "cat [-n] <fichier...>",
    args: [
      {
        name: "files",
        type: "path",
        required: true,
        variadic: true,
        description: "fichiers à afficher",
      },
    ],
    options: [
      {
        long: "number",
        short: "n",
        takesValue: false,
        description: "numérote les lignes",
      },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY, [], [Capability.FS_READ]),
    category: "fichiers",
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const files = ctx.args.get<string[]>("files");
    const numbered = ctx.args.flag("number");
    const actor = toFileSystemActor(ctx.session.user);
    for (const file of files) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, file);
      const content = await ctx.machine.fs.readFile(path, actor); // méthode interne
      const output = numbered
        ? content
            .split("\n")
            .map((l, i) => `${i + 1}\t${l}`)
            .join("\n")
        : content;
      await ctx.io.stdout.write(output + "\n");
    }
    return EXIT_OK;
  }
}
