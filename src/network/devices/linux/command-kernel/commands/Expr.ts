import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { runExpr } from '../../coreutils/ExprEvaluator';

/**
 * `expr` — évalue une expression (arithmétique, comparaison, chaîne). Toute
 * l'évaluation (priorités, opérateurs `+ - \* / % = < > \| &`, `match`,
 * `substr`, `length`, `index`) est portée par l'évaluateur pur partagé
 * `runExpr` ; la commande ne fait que capter les opérandes bruts et écrire
 * le résultat suivi d'un saut de ligne (comportement GNU). Le code de sortie
 * de GNU `expr` est conservé : `0` si le résultat est vrai (non nul/non
 * vide), `1` s'il est faux, `2`/`3` sur erreur.
 */
export class ExprCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'expr',
    summary: 'Évalue une expression',
    usage: 'expr EXPRESSION',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'jetons de l\'expression' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const operands = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const result = runExpr(operands);
    const body = result.output === '' ? '' : (result.output.endsWith('\n') ? result.output : result.output + '\n');
    await ctx.io.stdout.write(body);
    return result.exitCode as ExitCode;
  }
}
