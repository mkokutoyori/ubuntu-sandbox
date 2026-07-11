import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class ClsCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'cls',
    summary: 'Efface l\'écran',
    usage: 'cls',
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'session',
  };

  async execute(_ctx: CommandContext): Promise<ExitCode> {
    return EXIT_OK;
  }
}
