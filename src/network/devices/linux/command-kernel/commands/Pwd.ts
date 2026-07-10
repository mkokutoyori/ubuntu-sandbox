import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class PwdCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'pwd',
    summary: 'Affiche le répertoire de travail courant',
    usage: 'pwd',
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stdout.write(ctx.session.cwd + '\n');
    return EXIT_OK;
  }
}
