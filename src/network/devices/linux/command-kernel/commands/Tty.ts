import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

/** Terminal attribué à une session interactive de ce simulateur. */
const CONTROLLING_TTY = '/dev/pts/0';

/**
 * `tty` — affiche le nom du terminal relié à l'entrée standard. Commande
 * autonome : toute la logique (détection du mode exec-SSH sans
 * pseudo-terminal via `SSH_NO_TTY`, format du chemin, option `-s`) est
 * implémentée ici, sans dépendance à un module hérité.
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

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // `tty` n'accepte que l'option `-s` (déjà contrôlée par le parseur) et
    // aucun opérande : rien de plus à valider.
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const silent = ctx.args.flag('silent');
    if (ctx.session.env.get('SSH_NO_TTY') === '1') {
      if (!silent) await ctx.io.stdout.write('not a tty\n');
      return 1;
    }
    if (!silent) await ctx.io.stdout.write(CONTROLLING_TTY + '\n');
    return EXIT_OK;
  }
}
