import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { FileSystemError } from '@/command-kernel/errors';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

function reasonOf(err: FileSystemError): string {
  const prefix = `${err.path}: `;
  return err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message;
}

export class RmdirCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'rmdir',
    summary: 'Supprime un répertoire vide',
    usage: 'rmdir <répertoire...>',
    args: [{ name: 'targets', type: 'path', required: true, variadic: true, description: 'répertoires à supprimer' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.get<string[]>('targets');
    const actor = toFileSystemActor(ctx.session.user);

    for (const target of targets) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, target);
      try {
        await ctx.machine.fs.rmdir(path, actor);
      } catch (err) {
        if (!(err instanceof FileSystemError)) throw err;
        await ctx.io.stdout.write(`rmdir: failed to remove '${target}': ${reasonOf(err)}\n`);
        return 1;
      }
      ctx.machine.audit?.fsAccess(path, 'w', 'rmdir');
      ctx.machine.audit?.syscall('rmdir', path);
    }
    return EXIT_OK;
  }
}
