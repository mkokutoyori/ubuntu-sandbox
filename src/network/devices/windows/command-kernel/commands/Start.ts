import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class StartCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'start',
    summary: 'Lance un programme dans une nouvelle fenêtre',
    usage: 'start ["titre"] [/b] [/wait] [/min] programme [arguments]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options et programme' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const tokens = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const filtered = tokens.filter((t) => !t.startsWith('/'));
    if (filtered.length === 0) return EXIT_OK;

    let target = filtered[0].replace(/^["']|["']$/g, '');
    if (filtered.length >= 2 && /^"[^"]*"$/.test(tokens.find((t) => /^"[^"]*"$/.test(t)) ?? '')) {
      target = filtered[1].replace(/^["']|["']$/g, '');
    }
    if (!target) return EXIT_OK;

    const leaf = target.split(/[\\/]/).pop() ?? target;
    const imageName = /\.exe$/i.test(leaf) ? leaf : `${leaf}.exe`;
    await ctx.machine.proc.spawn(imageName, []);
    return EXIT_OK;
  }
}
