import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** `atrm JOB_ID...` — délègue à `machine.atJobs.atrm()` (fonction pure `cmdAtrm` contre la vraie file `at`). */
export class AtrmCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'atrm',
    summary: 'Supprime une tâche de la file at',
    usage: 'atrm JOB_ID...',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'identifiants de tâche' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const out = ctx.machine.atJobs!.atrm(args);
    if (out) await ctx.io.stdout.write(out + '\n');
    return EXIT_OK;
  }
}
