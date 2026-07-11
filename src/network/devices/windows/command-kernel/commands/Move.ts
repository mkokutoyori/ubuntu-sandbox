import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { reportLegacyFsError } from './legacyFsError';

export class MoveCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'move',
    summary: 'Déplace un fichier',
    usage: 'move <source> <destination>',
    args: [
      { name: 'source', type: 'string', required: false, description: 'fichier source' },
      { name: 'destination', type: 'string', required: false, description: 'fichier destination' },
    ],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (!ctx.args.has('source') || !ctx.args.has('destination')) {
      await ctx.io.stdout.write('The syntax of the command is incorrect.\n');
      return EXIT_OK;
    }
    const src = ctx.machine.fs.resolve(ctx.session.cwd, ctx.args.get<string>('source'));
    const dest = ctx.machine.fs.resolve(ctx.session.cwd, ctx.args.get<string>('destination'));
    const actor = toFileSystemActor(ctx.session.user);
    try {
      await ctx.machine.fs.rename(src, dest, actor);
    } catch (err) {
      return reportLegacyFsError(ctx, err);
    }
    await ctx.io.stdout.write('        1 file(s) moved.\n');
    return EXIT_OK;
  }
}
