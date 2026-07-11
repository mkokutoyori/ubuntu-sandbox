import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class SortCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'sort',
    summary: 'Trie les lignes d\'un fichier',
    usage: 'sort [/r] <fichier>',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options et fichier' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const tokens = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    let reverse = false;
    const files: string[] = [];
    for (const t of tokens) {
      if (t.toLowerCase() === '/r') { reverse = true; continue; }
      files.push(t);
    }
    if (files.length === 0) {
      await ctx.io.stdout.write('\n');
      return EXIT_OK;
    }

    const actor = toFileSystemActor(ctx.session.user);
    const abs = ctx.machine.fs.resolve(ctx.session.cwd, files[0]);
    let content: string;
    try {
      content = await ctx.machine.fs.readFile(abs, actor);
    } catch {
      await ctx.io.stdout.write('The system cannot find the file specified.\n');
      return 1;
    }

    const lines = content.split('\n');
    lines.sort((a, b) => a.localeCompare(b));
    if (reverse) lines.reverse();
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}
