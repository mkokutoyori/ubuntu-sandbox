import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class HostnameCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'hostname',
    summary: "Affiche le nom d'hôte",
    usage: 'hostname',
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stdout.write(ctx.machine.hostname + '\n');
    return EXIT_OK;
  }
}
