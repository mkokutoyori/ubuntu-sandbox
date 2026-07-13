import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

/**
 * `nice [-n adjustement] [commande]` — exécute une commande avec une
 * gentillesse ajustée. Commande **autonome** : sans commande, affiche la
 * gentillesse courante (0 en l'absence d'état de shell dédié) ; avec une
 * commande, l'exécution réelle n'étant pas simulée, l'ajustement est
 * validé puis l'appel est un no-op (code 0).
 */
export class NiceCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'nice',
    summary: 'Exécute une commande avec une gentillesse ajustée',
    usage: 'nice [-n adjustement] [commande [args]]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[-n adj] [commande]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // Un ajustement invalide est une erreur d'exécution (code 1), rendue
    // dans `execute` avec le message GNU exact.
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    if (args.length === 0) {
      // Sans commande : affiche la gentillesse courante.
      await ctx.io.stdout.write('0\n');
      return 0;
    }
    let i = 0;
    let adj = 10;
    if (args[0] === '-n' || args[0] === '--adjustment') {
      adj = Number(args[1]);
      i = 2;
    } else if (/^-n./.test(args[0]) || /^--adjustment=/.test(args[0])) {
      adj = Number(args[0].replace(/^(-n|--adjustment=)/, ''));
      i = 1;
    } else if (/^-\d+$/.test(args[0])) {
      adj = Number(args[0]);
      i = 1;
    }
    if (Number.isNaN(adj)) {
      await ctx.io.stdout.write(`nice: invalid adjustment '${args[1] ?? args[0]}'\n`);
      return 1;
    }
    // Le fork réel n'est pas modélisé : la commande s'exécuterait à la
    // gentillesse ajustée. No-op ici.
    void i;
    return 0;
  }
}
