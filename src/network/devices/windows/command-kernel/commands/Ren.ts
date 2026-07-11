import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { reportLegacyFsError } from './legacyFsError';

export class RenCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ren',
    aliases: ['rename'],
    summary: 'Renomme un fichier',
    usage: 'ren <fichier> <nouveau-nom>',
    args: [
      { name: 'source', type: 'string', required: false, description: 'fichier à renommer' },
      { name: 'newName', type: 'string', required: false, description: 'nouveau nom' },
    ],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (!ctx.args.has('source') || !ctx.args.has('newName')) {
      await ctx.io.stdout.write('The syntax of the command is incorrect.\n');
      return EXIT_OK;
    }
    const src = ctx.machine.fs.resolve(ctx.session.cwd, ctx.args.get<string>('source'));
    const newName = ctx.args.get<string>('newName');
    const actor = toFileSystemActor(ctx.session.user);
    const parent = src.slice(0, src.lastIndexOf('\\'));
    const dest = `${parent}\\${newName}`;

    // Legacy `renameEntry` rejects a collision before touching anything —
    // `rename()` (backed by `moveFile`) would instead silently overwrite an
    // existing file, so the check is reproduced here explicitly. A pure
    // case change (`ren a.txt A.txt`) is not a collision with itself.
    if (dest.toLowerCase() !== src.toLowerCase() && await ctx.machine.fs.exists(dest, actor)) {
      await ctx.io.stdout.write('A duplicate file name exists, or the file cannot be found.\n');
      return EXIT_OK;
    }
    try {
      await ctx.machine.fs.rename(src, dest, actor);
    } catch (err) {
      return reportLegacyFsError(ctx, err);
    }
    return EXIT_OK;
  }
}
