import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ROOT = new DefaultPrivilegePolicy(PrivilegeLevel.ROOT);

/**
 * `groupmod [-g GID] [-n NEWNAME] GROUP` — délègue à
 * `machine.groups.posixGroupmod` (`LinuxUserManager.groupmod`, message
 * vendeur exact).
 */
export class GroupmodCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'groupmod',
    summary: 'Modifie un groupe existant',
    usage: 'groupmod [-g GID] [-n NEWNAME] GROUP',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-g GID, -n NEWNAME GROUP' },
    ],
    options: [],
    privileges: ROOT,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];

    let gid: number | undefined, newName: string | undefined;
    let name = '';
    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case '-g': gid = parseInt(args[++i], 10); break;
        case '-n': newName = args[++i]; break;
        default:
          if (!args[i].startsWith('-')) name = args[i];
          break;
      }
    }
    if (!name) {
      await ctx.io.stdout.write('groupmod: missing group name\n');
      return 1;
    }

    const result = ctx.machine.groups.posixGroupmod?.(name, { gid, newName }) ?? '';
    if (result) {
      await ctx.io.stdout.write(result + '\n');
      return 1;
    }
    return EXIT_OK;
  }
}
