import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { reportLegacyFsError } from './legacyFsError';

export class RmdirCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'rmdir',
    aliases: ['rd'],
    summary: 'Supprime un répertoire',
    usage: 'rmdir [/s] [/q] <répertoire>',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'répertoire à supprimer' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    let recursive = false;
    const pathParts: string[] = [];
    for (const arg of targets) {
      const lower = arg.toLowerCase();
      if (lower === '/s') recursive = true;
      else if (lower === '/q') continue;
      else pathParts.push(arg);
    }
    if (pathParts.length === 0) {
      await ctx.io.stdout.write('The syntax of the command is incorrect.\n');
      return EXIT_OK;
    }

    const abs = ctx.machine.fs.resolve(ctx.session.cwd, pathParts.join(' '));
    const actor = toFileSystemActor(ctx.session.user);
    try {
      await ctx.machine.fs.remove(abs, actor, recursive);
    } catch (err) {
      return reportLegacyFsError(ctx, err);
    }
    return EXIT_OK;
  }
}
