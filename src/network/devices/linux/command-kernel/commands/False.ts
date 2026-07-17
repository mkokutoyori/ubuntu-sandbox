import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** `false` — ne fait rien, échoue toujours (aucun état à lire). */
export class FalseCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'false',
    summary: 'Ne fait rien, échoue toujours',
    usage: 'false',
    args: [
      { name: 'ignored', type: 'string', required: false, variadic: true, description: 'ignoré (parité vendeur)' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(_ctx: CommandContext): Promise<ExitCode> {
    return 1;
  }
}
