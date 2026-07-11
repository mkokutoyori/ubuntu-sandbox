import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { joinLines, splitLines } from './textInput';

export class CatCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'cat',
    summary: 'Affiche le contenu d\'un ou plusieurs fichiers',
    usage: 'cat [-n] [fichier...]',
    args: [{ name: 'files', type: 'path', required: false, variadic: true, description: 'fichiers à afficher' }],
    options: [{ long: 'number', short: 'n', takesValue: false, description: 'numérote les lignes' }],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const files = ctx.args.has('files') ? ctx.args.get<string[]>('files') : [];
    const numbered = ctx.args.flag('number');
    const actor = toFileSystemActor(ctx.session.user);

    const writeContent = async (content: string) => {
      if (!numbered) {
        await ctx.io.stdout.write(content);
        return;
      }
      const { lines, hasTrailingNewline } = splitLines(content);
      const numberedLines = lines.map((l, i) => `${i + 1}\t${l}`);
      await ctx.io.stdout.write(joinLines(numberedLines, true, hasTrailingNewline));
    };

    if (files.length === 0) {
      await writeContent(await ctx.io.stdin.readAll());
      return EXIT_OK;
    }
    for (const file of files) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, file);
      const content = await ctx.machine.fs.readFile(path, actor);
      await writeContent(content);
    }
    return EXIT_OK;
  }
}
