import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class MkdirCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'mkdir',
    aliases: ['md'],
    summary: 'Crée un répertoire (et ses parents)',
    usage: 'mkdir <répertoire>',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'répertoire à créer' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (targets.length === 0) {
      await ctx.io.stdout.write('The syntax of the command is incorrect.\n');
      return EXIT_OK;
    }

    const path = targets.join(' ');
    const abs = ctx.machine.fs.resolve(ctx.session.cwd, path);
    const actor = toFileSystemActor(ctx.session.user);
    if (await ctx.machine.fs.exists(abs, actor)) {
      await ctx.io.stdout.write(`A subdirectory or file ${path} already exists.\n`);
      return EXIT_OK;
    }
    // Legacy `cmdMkdir` always creates intermediate directories.
    await ctx.machine.fs.mkdir(abs, actor, true);
    return EXIT_OK;
  }
}
