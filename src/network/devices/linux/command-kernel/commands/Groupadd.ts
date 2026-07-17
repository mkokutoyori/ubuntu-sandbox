import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ROOT = new DefaultPrivilegePolicy(PrivilegeLevel.ROOT);

/**
 * `groupadd [-g GID] GROUP` — délègue à `machine.groups.posixGroupadd`
 * (`LinuxUserManager.groupadd`, message vendeur exact).
 */
export class GroupaddCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'groupadd',
    summary: 'Crée un groupe',
    usage: 'groupadd [-g GID] GROUP',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-g GID GROUP' },
    ],
    options: [],
    privileges: ROOT,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];

    let gid: number | undefined;
    let name = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-g') { gid = parseInt(args[++i], 10); continue; }
      if (!args[i].startsWith('-')) name = args[i];
    }
    if (!name) {
      await ctx.io.stdout.write('groupadd: missing group name\n');
      return 1;
    }

    const result = ctx.machine.groups.posixGroupadd?.(name, gid) ?? '';
    if (result) {
      await ctx.io.stdout.write(result + '\n');
      return 1;
    }
    return EXIT_OK;
  }
}
