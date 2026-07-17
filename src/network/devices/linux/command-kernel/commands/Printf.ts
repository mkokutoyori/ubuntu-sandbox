import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { countFormatSpecs, printfFormat } from '@/bash/runtime/Builtins';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `printf [-v var] format [arguments...]` — délègue le formatage à
 * `printfFormat`/`countFormatSpecs` (fonctions pures du moteur bash,
 * partagées avec le builtin `printf` du script interpreter — même
 * grammaire de format, jamais réimplémentée en double). `-v var` écrit
 * dans `session.variables` (variables locales de script `$x`).
 */
export class PrintfCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'printf',
    summary: 'Formate et affiche des données',
    usage: 'printf [-v var] format [arguments...]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-v var, format, arguments' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    if (args.length === 0) {
      await ctx.io.stdout.write('bash: printf: usage: printf [-v var] format [arguments]\n');
      return 1;
    }

    let targetVar: string | null = null;
    let fmtStart = 0;
    if (args[0] === '-v' && args.length >= 3) {
      targetVar = args[1];
      fmtStart = 2;
    }

    const format = args[fmtStart];
    const fmtArgs = args.slice(fmtStart + 1);
    let output = '';
    let argIdx = 0;
    do {
      const startArgIdx = argIdx;
      output += printfFormat(format, fmtArgs, argIdx);
      argIdx = startArgIdx + countFormatSpecs(format);
    } while (argIdx < fmtArgs.length && argIdx > 0);

    if (targetVar) {
      ctx.session.variables.set(targetVar, output);
      return EXIT_OK;
    }
    await ctx.io.stdout.write(output);
    return EXIT_OK;
  }
}
