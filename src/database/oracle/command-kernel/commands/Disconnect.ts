import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** DISCONNECT / DISC — ferme la connexion sans quitter SQL*Plus. */
export class SqlPlusDisconnectCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'DISCONNECT',
    aliases: ['DISC'],
    summary: 'Ferme la connexion Oracle courante sans quitter SQL*Plus',
    usage: 'DISCONNECT',
    args: [],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const oracle = ctx.machine.oracle!;
    if (!oracle.isConnected()) {
      await ctx.io.stdout.write('Not connected.\n');
      return EXIT_OK;
    }
    oracle.disconnect();
    await ctx.io.stdout.write('Disconnected from Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production\n');
    return EXIT_OK;
  }
}
