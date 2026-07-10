import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class MvCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'mv',
    summary: 'Déplace ou renomme un fichier',
    usage: 'mv <source> <destination>',
    args: [
      { name: 'source', type: 'path', required: true, description: 'fichier source' },
      { name: 'destination', type: 'path', required: true, description: 'destination' },
    ],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const source = ctx.machine.fs.resolve(ctx.session.cwd, ctx.args.get<string>('source'));
    const destination = ctx.machine.fs.resolve(ctx.session.cwd, ctx.args.get<string>('destination'));
    await ctx.machine.fs.rename(source, destination, toFileSystemActor(ctx.session.user));
    return EXIT_OK;
  }
}
