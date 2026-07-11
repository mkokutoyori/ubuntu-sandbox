import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class MkdirCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'mkdir',
    summary: 'Crée un ou plusieurs répertoires',
    usage: 'mkdir [-p] <répertoire...>',
    args: [{ name: 'targets', type: 'path', required: true, variadic: true, description: 'répertoires à créer' }],
    options: [{ long: 'parents', short: 'p', takesValue: false, description: 'crée les répertoires parents manquants' }],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.get<string[]>('targets');
    const parents = ctx.args.flag('parents');
    const actor = toFileSystemActor(ctx.session.user);
    for (const target of targets) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, target);
      await ctx.machine.fs.mkdir(path, actor, parents);
      ctx.machine.audit?.fsAccess(path, 'w', 'mkdir');
      ctx.machine.audit?.syscall('mkdir', path);
    }
    return EXIT_OK;
  }
}
