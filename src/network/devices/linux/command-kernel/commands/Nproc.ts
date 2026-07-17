import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** `nproc` — affiche le nombre de processeurs logiques (`machine.metrics.cpu().logicalCpus`). */
export class NprocCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'nproc',
    summary: 'Affiche le nombre de processeurs logiques',
    usage: 'nproc',
    args: [
      { name: 'ignored', type: 'string', required: false, variadic: true, description: 'ignoré (parité vendeur)' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stdout.write(`${ctx.machine.metrics!.cpu().logicalCpus}\n`);
    return EXIT_OK;
  }
}
