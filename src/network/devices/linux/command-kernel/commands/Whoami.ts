import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class WhoamiCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'whoami',
    summary: 'Affiche le nom de l\'utilisateur courant',
    usage: 'whoami',
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'session',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stdout.write(ctx.session.user.name + '\n');
    return EXIT_OK;
  }
}
