import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { joinLines, readTextInput, splitLines } from './textInput';

export class HeadCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'head',
    summary: 'Affiche les premières lignes d\'un fichier ou de l\'entrée standard',
    usage: 'head [-n N] [-c N] [fichier...]',
    args: [{ name: 'files', type: 'path', required: false, variadic: true, description: 'fichiers à lire' }],
    options: [
      { long: 'lines', short: 'n', takesValue: true, type: 'int', defaultValue: 10, numericShorthand: true, description: 'nombre de lignes' },
      { long: 'bytes', short: 'c', takesValue: true, type: 'int', description: 'nombre d\'octets' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const files = ctx.args.has('files') ? ctx.args.get<string[]>('files') : [];
    const content = await readTextInput(ctx, files);

    if (ctx.args.has('bytes')) {
      await ctx.io.stdout.write(content.slice(0, ctx.args.get<number>('bytes')));
      return EXIT_OK;
    }

    const count = ctx.args.get<number>('lines');
    const { lines, hasTrailingNewline } = splitLines(content);
    const selected = lines.slice(0, count);
    await ctx.io.stdout.write(joinLines(selected, selected.length === lines.length, hasTrailingNewline));
    return EXIT_OK;
  }
}
