import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ROOT = new DefaultPrivilegePolicy(PrivilegeLevel.ROOT);

/**
 * `groupdel GROUP` — délègue à `machine.groups.posixGroupdel`
 * (`LinuxUserManager.groupdel`, message vendeur exact).
 */
export class GroupdelCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'groupdel',
    summary: 'Supprime un groupe',
    usage: 'groupdel GROUP',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'GROUP' },
    ],
    options: [],
    privileges: ROOT,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const name = args.find((a) => !a.startsWith('-'));
    if (!name) {
      await ctx.io.stdout.write('groupdel: missing group name\n');
      return 1;
    }

    const result = ctx.machine.groups.posixGroupdel?.(name) ?? '';
    if (result) {
      await ctx.io.stdout.write(result + '\n');
      return 1;
    }
    return EXIT_OK;
  }
}
