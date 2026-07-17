import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `gpasswd` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class GpasswdCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'gpasswd',
    summary: 'Administre les membres et administrateurs d\'un groupe',
    usage: 'gpasswd [-d|-A|-M arg] GROUP',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-d USER GROUP, -A/-M liste GROUP' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const output = ctx.machine.groups.posixGpasswd?.(args) ?? '';
    if (output) await ctx.io.stdout.write(output + '\n');
    return output.includes('does not exist') ? 1 : EXIT_OK;
  }
}
