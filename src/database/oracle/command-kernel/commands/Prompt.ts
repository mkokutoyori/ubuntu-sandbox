import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `PROMPT [texte]` — affiche le texte tel quel (aucune donnée machine :
 * pas de capacité `oracle` nécessaire). `PROMPT` seul affiche une ligne vide.
 */
export class SqlPlusPromptCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'PROMPT',
    summary: 'Affiche du texte à l\'écran',
    usage: 'PROMPT [texte]',
    args: [
      { name: 'text', type: 'string', required: false, description: 'texte à afficher tel quel' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const text = ctx.args.get<string | undefined>('text') ?? '';
    await ctx.io.stdout.write(`${text}\n`);
    return EXIT_OK;
  }
}
