import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** `atq` — délègue à `machine.atJobs.atq()` (fonction pure `cmdAtq` contre la vraie file `at`). */
export class AtqCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'atq',
    summary: 'Liste les tâches en attente dans la file at',
    usage: 'atq',
    args: [],
    options: [],
    privileges: ANY,
    category: 'linux',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const out = ctx.machine.atJobs!.atq();
    if (out) await ctx.io.stdout.write(out + '\n');
    return EXIT_OK;
  }
}
