import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { joinLines, readTextInput, splitLines } from './textInput';

export class TailCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'tail',
    summary: 'Affiche les dernières lignes d\'un fichier ou de l\'entrée standard',
    usage: 'tail [-n N] [fichier...]',
    args: [{ name: 'files', type: 'path', required: false, variadic: true, description: 'fichiers à lire' }],
    options: [
      { long: 'lines', short: 'n', takesValue: true, type: 'int', defaultValue: 10, numericShorthand: true, description: 'nombre de lignes' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const files = ctx.args.has('files') ? ctx.args.get<string[]>('files') : [];
    const count = ctx.args.get<number>('lines');
    const content = await readTextInput(ctx, files);
    const { lines, hasTrailingNewline } = splitLines(content);
    const selected = count >= lines.length ? [...lines] : lines.slice(lines.length - count);
    await ctx.io.stdout.write(joinLines(selected, true, hasTrailingNewline));
    return EXIT_OK;
  }
}
