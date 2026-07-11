import { BaseCommand } from "../command/base-command";
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from "../command/types";
import { DefaultPrivilegePolicy } from "../session/privilege-policy";
import { PrivilegeLevel } from "../session/types";

const ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
};

/** Interprète les échappements bash de `echo -e` (\n, \t, \\...). `\c` tronque la sortie restante. */
function interpretEscapes(word: string): { text: string; stop: boolean } {
  let out = "";
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== "\\" || i === word.length - 1) {
      out += word[i];
      continue;
    }
    const next = word[i + 1];
    if (next === "c") return { text: out, stop: true };
    if (next in ESCAPES) {
      out += ESCAPES[next];
      i++;
      continue;
    }
    out += word[i];
  }
  return { text: out, stop: false };
}

/** Universelle, ne touche jamais MachineApi : candidate à registerCoreCommands. */
export class EchoCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: "echo",
    summary: "Affiche ses arguments",
    usage: "echo [-n] [-e|-E] <mots...>",
    args: [
      {
        name: "words",
        type: "string",
        required: false,
        variadic: true,
        description: "mots à afficher",
      },
    ],
    options: [
      {
        long: "no-newline",
        short: "n",
        takesValue: false,
        description: "n'ajoute pas de retour à la ligne final",
      },
      {
        long: "escape",
        short: "e",
        takesValue: false,
        description: "interprète les échappements (\\n, \\t...)",
      },
      {
        long: "no-escape",
        short: "E",
        takesValue: false,
        description: "n'interprète pas les échappements (défaut)",
      },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: "session",
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const words = ctx.args.has("words") ? ctx.args.get<string[]>("words") : [];
    const noNewline = ctx.args.flag("no-newline");
    const escape = ctx.args.flag("escape");

    let body = words.join(" ");
    let stop = false;
    if (escape) {
      const interpreted = words.map((w) => interpretEscapes(w));
      stop = interpreted.some((w) => w.stop);
      body = interpreted.map((w) => w.text).join(" ");
    }

    await ctx.io.stdout.write(body + (noNewline || stop ? "" : "\n"));
    return EXIT_OK;
  }
}
