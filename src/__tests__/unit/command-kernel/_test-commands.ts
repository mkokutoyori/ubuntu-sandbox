import { BaseCommand } from "@/command-kernel/command/base-command";
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from "@/command-kernel/command/types";
import { UsageError } from "@/command-kernel/errors";
import { DefaultPrivilegePolicy } from "@/command-kernel/session/privilege-policy";
import { PrivilegeLevel } from "@/command-kernel/session/types";

/** Écrit ses arguments sur stdout, séparés par des espaces. */
export class EchoCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: "echo",
    summary: "Affiche ses arguments",
    usage: "echo <mots...>",
    args: [{ name: "words", type: "string", required: false, variadic: true, description: "mots" }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const words = ctx.args.has("words") ? ctx.args.get<string[]>("words") : [];
    await ctx.io.stdout.write(words.join(" ") + "\n");
    return EXIT_OK;
  }
}

/** Lit tout stdin et le réécrit en majuscules sur stdout (teste les pipes). */
export class UpperCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: "upper",
    summary: "Met stdin en majuscules",
    usage: "upper",
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const input = await ctx.io.stdin.readAll();
    await ctx.io.stdout.write(input.toUpperCase());
    return EXIT_OK;
  }
}

/** Retourne toujours 0. */
export class TrueCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: "true",
    summary: "Réussit toujours",
    usage: "true",
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
  };
  async execute(): Promise<ExitCode> {
    return EXIT_OK;
  }
}

/** Retourne toujours 1. */
export class FalseCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: "false",
    summary: "Échoue toujours",
    usage: "false",
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
  };
  async execute(): Promise<ExitCode> {
    return 1;
  }
}

/** Lève systématiquement une UsageError (teste la capture d'erreur interne). */
export class FailCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: "fail",
    summary: "Échoue avec une erreur métier",
    usage: "fail",
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
  };
  async execute(): Promise<ExitCode> {
    throw new UsageError("échec volontaire");
  }
}

/** Incrémente un compteur partagé à chaque exécution (teste les boucles). */
export class CounterCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: "count",
    summary: "Incrémente un compteur partagé",
    usage: "count",
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
  };

  constructor(private readonly counter: { value: number; seen: string[] }) {
    super();
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    this.counter.value++;
    this.counter.seen.push(ctx.session.variables.get("x") ?? "");
    return EXIT_OK;
  }
}
