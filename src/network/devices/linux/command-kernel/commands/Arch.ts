import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** `arch` — affiche l'architecture matérielle (`machine.metrics.cpu().architecture`). */
export class ArchCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'arch',
    summary: 'Affiche l\'architecture matérielle',
    usage: 'arch',
    args: [
      { name: 'extra', type: 'string', required: false, variadic: true, description: 'aucun opérande attendu' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const extra = ctx.args.get<string[] | undefined>('extra') ?? [];
    if (extra.length > 0) {
      await ctx.io.stdout.write(`arch: extra operand '${extra[0]}'\n`);
      return EXIT_OK;
    }
    await ctx.io.stdout.write(`${ctx.machine.metrics!.cpu().architecture}\n`);
    return EXIT_OK;
  }
}
