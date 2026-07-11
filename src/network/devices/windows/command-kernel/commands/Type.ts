import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { reportLegacyFsError } from './legacyFsError';

export class TypeCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'type',
    summary: 'Affiche le contenu d\'un fichier',
    usage: 'type <fichier>',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'fichier à afficher' }],
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

    const abs = ctx.machine.fs.resolve(ctx.session.cwd, targets.join(' '));
    const actor = toFileSystemActor(ctx.session.user);
    try {
      const content = await ctx.machine.fs.readFile(abs, actor);
      await ctx.io.stdout.write(content);
    } catch (err) {
      return reportLegacyFsError(ctx, err);
    }
    return EXIT_OK;
  }
}
