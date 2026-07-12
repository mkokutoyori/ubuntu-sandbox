import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { runSeq } from '../../coreutils/SeqGenerator';

/**
 * `seq` — génère une suite de nombres. Le rendu (formats GNU `-w`/`-f`/`-s`,
 * précision, pas négatif...) est porté par le générateur pur partagé
 * `runSeq` ; la commande ne fait que capter les opérandes bruts et écrire le
 * résultat en terminant par un saut de ligne (comportement GNU).
 */
export class SeqCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'seq',
    summary: 'Génère une suite de nombres',
    usage: 'seq [-w] [-s CHAÎNE] [-f FORMAT] DERNIER\n   ou : seq [OPTION]... PREMIER [PAS] DERNIER',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'PREMIER [PAS] DERNIER' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const operands = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const result = runSeq(operands);
    // `runSeq` ne pose pas de saut de ligne final ; GNU `seq` en produit un
    // dès que la sortie est non vide (y compris les messages d'erreur).
    const body = result.output === '' ? '' : (result.output.endsWith('\n') ? result.output : result.output + '\n');
    await ctx.io.stdout.write(body);
    return result.exitCode as ExitCode;
  }
}
