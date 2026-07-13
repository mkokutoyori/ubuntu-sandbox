import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';
import { joinLines, readTextInput, splitLines } from './textInput';

/**
 * `rev` — inverse l'ordre des caractères de chaque ligne. Lit l'entrée
 * standard ou les fichiers passés en argument (comportement GNU, plus
 * complet que le legacy limité à stdin) ; la structure des lignes et le
 * saut de ligne final sont préservés à l'octet près.
 */
export class RevCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'rev',
    summary: 'Inverse les caractères de chaque ligne',
    usage: 'rev [fichier...]',
    args: [{ name: 'files', type: 'path', required: false, variadic: true, description: 'fichiers à lire' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // `rev` accepte zéro fichier (lecture de stdin) ou des chemins — rien de
    // plus à valider en amont ; une lecture échouée est signalée à l'exécution.
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const files = ctx.args.has('files') ? ctx.args.get<string[]>('files') : [];
    const content = await readTextInput(ctx, files);
    const { lines, hasTrailingNewline } = splitLines(content);
    const reversed = lines.map((l) => [...l].reverse().join(''));
    await ctx.io.stdout.write(joinLines(reversed, true, hasTrailingNewline));
    return EXIT_OK;
  }
}
