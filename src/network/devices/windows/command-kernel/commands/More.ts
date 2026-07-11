import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class MoreCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'more',
    summary: 'Affiche le contenu page par page (simulation : passthrough)',
    usage: 'more <fichier>',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'fichier' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const tokens = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (tokens.length === 0) {
      const piped = await ctx.io.stdin.readAll();
      await ctx.io.stdout.write(piped + '\n');
      return EXIT_OK;
    }

    const path = tokens.join(' ');
    const actor = toFileSystemActor(ctx.session.user);
    const abs = ctx.machine.fs.resolve(ctx.session.cwd, path);
    let content: string;
    try {
      content = await ctx.machine.fs.readFile(abs, actor);
    } catch {
      await ctx.io.stdout.write(`Cannot access file ${path}\n`);
      return 1;
    }
    await ctx.io.stdout.write(content + '\n');
    return EXIT_OK;
  }
}
