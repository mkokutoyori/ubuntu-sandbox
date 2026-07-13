import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { cmdTty } from '../../system/SystemInfo';

/**
 * `tty` — affiche le nom du terminal relié à l'entrée standard. En mode
 * exec SSH sans pseudo-terminal (le client pose `SSH_NO_TTY=1`), répond
 * « not a tty » avec le code de sortie 1, comme le vrai `tty`. Le formatage
 * du chemin reste porté par le helper pur partagé `cmdTty`.
 */
export class TtyCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'tty',
    summary: 'Affiche le nom du terminal',
    usage: 'tty [-s]',
    args: [],
    options: [
      { long: 'silent', short: 's', takesValue: false, description: 'aucune sortie, seul le code de retour compte' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const silent = ctx.args.flag('silent');
    if (ctx.session.env.get('SSH_NO_TTY') === '1') {
      if (!silent) await ctx.io.stdout.write('not a tty\n');
      return 1;
    }
    if (!silent) await ctx.io.stdout.write(cmdTty('pts/0') + '\n');
    return EXIT_OK;
  }
}
