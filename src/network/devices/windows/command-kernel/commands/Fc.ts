import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class FcCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'fc',
    summary: 'Compare deux fichiers',
    usage: 'fc [/c] <fichier1> <fichier2>',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options et fichiers' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const tokens = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];

    let ignoreCase = false;
    const filePaths: string[] = [];
    for (const t of tokens) {
      const lower = t.toLowerCase();
      if (lower === '/n' || lower === '/l' || lower === '/a') continue;
      if (lower === '/c') { ignoreCase = true; continue; }
      filePaths.push(t);
    }

    if (filePaths.length < 2) {
      await ctx.io.stdout.write('FC: Insufficient number of file specifications\n');
      return 2;
    }

    const actor = toFileSystemActor(ctx.session.user);
    const abs1 = ctx.machine.fs.resolve(ctx.session.cwd, filePaths[0]);
    const abs2 = ctx.machine.fs.resolve(ctx.session.cwd, filePaths[1]);

    let content1: string;
    try {
      content1 = await ctx.machine.fs.readFile(abs1, actor);
    } catch {
      await ctx.io.stdout.write(`FC: cannot open ${filePaths[0]} - No such file or directory\n`);
      return 2;
    }
    let content2: string;
    try {
      content2 = await ctx.machine.fs.readFile(abs2, actor);
    } catch {
      await ctx.io.stdout.write(`FC: cannot open ${filePaths[1]} - No such file or directory\n`);
      return 2;
    }

    const lines1 = content1.split('\n');
    const lines2 = content2.split('\n');
    const lines: string[] = [`Comparing files ${filePaths[0].toUpperCase()} and ${filePaths[1].toUpperCase()}`];

    let hasDiff = false;
    const maxLen = Math.max(lines1.length, lines2.length);
    for (let i = 0; i < maxLen; i++) {
      const l1 = i < lines1.length ? lines1[i] : '';
      const l2 = i < lines2.length ? lines2[i] : '';
      const a = ignoreCase ? l1.toLowerCase() : l1;
      const b = ignoreCase ? l2.toLowerCase() : l2;
      if (a !== b) {
        hasDiff = true;
        lines.push(`***** ${filePaths[0].toUpperCase()}`);
        lines.push(l1);
        lines.push(`***** ${filePaths[1].toUpperCase()}`);
        lines.push(l2);
        lines.push('*****');
      }
    }

    if (!hasDiff) lines.push('FC: no differences encountered');
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return hasDiff ? 1 : EXIT_OK;
  }
}
