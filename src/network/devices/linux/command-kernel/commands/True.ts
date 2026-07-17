import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** `true` — ne fait rien, réussit toujours (aucun état à lire). */
export class TrueCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'true',
    summary: 'Ne fait rien, réussit toujours',
    usage: 'true',
    args: [
      { name: 'ignored', type: 'string', required: false, variadic: true, description: 'ignoré (parité vendeur)' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(_ctx: CommandContext): Promise<ExitCode> {
    return EXIT_OK;
  }
}
