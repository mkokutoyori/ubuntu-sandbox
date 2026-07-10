import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { FileSystemError } from '@/command-kernel/errors';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class CdCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'cd',
    summary: 'Change le répertoire de travail courant',
    usage: 'cd [répertoire]',
    args: [{ name: 'target', type: 'path', required: false, description: 'répertoire cible' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const requested = ctx.args.has('target')
      ? ctx.args.get<string>('target')
      : (ctx.session.env.get('HOME') ?? '/');
    const target = ctx.machine.fs.resolve(ctx.session.cwd, requested);
    const actor = toFileSystemActor(ctx.session.user);
    const stat = await ctx.machine.fs.stat(target, actor);
    if (stat.type !== 'directory') {
      throw new FileSystemError(target, 'ENOTDIR', `${target}: Not a directory`);
    }
    ctx.session.cwd = target;
    return EXIT_OK;
  }
}
