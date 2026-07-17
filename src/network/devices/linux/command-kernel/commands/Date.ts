import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { cmdDate } from '@/network/devices/linux/system/SystemInfo';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `date [-d DATESPEC] [+FORMAT]` — délègue à `cmdDate`, fonction pure sans
 * dépendance d'état (aucune donnée à lire via `machine` : uniquement les
 * arguments et l'horloge courante).
 */
export class DateCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'date',
    summary: 'Affiche ou formate la date/heure courante',
    usage: 'date [-d DATESPEC] [+FORMAT]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-d/--date DATESPEC, +FORMAT' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const rest = ctx.args.get<string[] | undefined>('rest') ?? [];
    await ctx.io.stdout.write(`${cmdDate(rest)}\n`);
    return EXIT_OK;
  }
}
