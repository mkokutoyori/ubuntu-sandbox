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

export class LnCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ln',
    summary: 'Crée un lien (physique par défaut, symbolique avec -s) vers un fichier',
    usage: 'ln [-s] <cible> <lien>',
    args: [
      { name: 'target', type: 'path', required: true, description: 'cible du lien' },
      { name: 'linkName', type: 'path', required: true, description: 'chemin du lien à créer' },
    ],
    options: [
      { long: 'symbolic', short: 's', takesValue: false, description: 'crée un lien symbolique au lieu d\'un lien physique' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const target = ctx.args.get<string>('target');
    const linkArg = ctx.args.get<string>('linkName');
    const symbolic = ctx.args.flag('symbolic');
    const actor = toFileSystemActor(ctx.session.user);
    const linkPath = ctx.machine.fs.resolve(ctx.session.cwd, linkArg);
    const kind = symbolic ? 'symbolic link' : 'hard link';

    try {
      if (symbolic) {
        await ctx.machine.fs.symlink(target, linkPath, actor);
      } else {
        const targetPath = ctx.machine.fs.resolve(ctx.session.cwd, target);
        await ctx.machine.fs.link(targetPath, linkPath, actor);
      }
    } catch (err) {
      if (!(err instanceof FileSystemError)) throw err;
      await ctx.io.stdout.write(`ln: failed to create ${kind} '${linkArg}': ${reasonOf(err)}\n`);
      return 1;
    }

    const syscall = symbolic ? 'symlink' : 'link';
    ctx.machine.audit?.fsAccess(linkPath, 'w', syscall);
    ctx.machine.audit?.syscall(syscall, linkPath);
    return EXIT_OK;
  }
}
