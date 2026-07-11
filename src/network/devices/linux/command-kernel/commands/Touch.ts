import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class TouchCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'touch',
    summary: 'Crée un fichier vide ou met à jour sa date de modification',
    usage: 'touch <fichier...>',
    args: [{ name: 'targets', type: 'path', required: true, variadic: true, description: 'fichiers à toucher' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.get<string[]>('targets');
    const actor = toFileSystemActor(ctx.session.user);
    for (const target of targets) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, target);
      await ctx.machine.fs.touch(path, actor);
      ctx.machine.audit?.fsAccess(path, 'w', 'open');
      ctx.machine.audit?.syscall('open', path);
    }
    return EXIT_OK;
  }
}
