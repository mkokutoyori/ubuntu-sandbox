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

export class RmCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'rm',
    summary: 'Supprime des fichiers ou des répertoires',
    usage: 'rm [-r] [-f] [--preserve-root|--no-preserve-root] <cible...>',
    args: [{ name: 'targets', type: 'path', required: true, variadic: true, description: 'cibles à supprimer' }],
    options: [
      { long: 'recursive', short: 'r', takesValue: false, description: 'supprime récursivement' },
      { long: 'force', short: 'f', takesValue: false, description: 'ignore les cibles inexistantes' },
      { long: 'preserve-root', takesValue: false, description: 'refuse `rm -rf /` (comportement par défaut)' },
      { long: 'no-preserve-root', takesValue: false, description: 'autorise `rm -rf /`' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.get<string[]>('targets');
    const recursive = ctx.args.flag('recursive');
    const force = ctx.args.flag('force');
    const preserveRoot = !ctx.args.flag('no-preserve-root');
    const actor = toFileSystemActor(ctx.session.user);

    for (const target of targets) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, target);

      if (path === '/' && recursive && preserveRoot) {
        await ctx.io.stdout.write(
          "rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n",
        );
        return 1;
      }

      const existed = await ctx.machine.fs.exists(path, actor);
      try {
        await ctx.machine.fs.remove(path, actor, recursive);
      } catch (err) {
        if (!(err instanceof FileSystemError)) throw err;
        if (force && err.code === 'ENOENT') continue;
        await ctx.io.stdout.write(`rm: cannot remove '${target}': ${reasonOf(err)}\n`);
        return 1;
      }
      if (existed) {
        ctx.machine.audit?.fsAccess(path, 'w', 'unlink');
        ctx.machine.audit?.syscall('unlink', path);
      }
    }
    return EXIT_OK;
  }
}
