import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ROOT = new DefaultPrivilegePolicy(PrivilegeLevel.ROOT);

/**
 * `userdel [-r] LOGIN` — délègue à `machine.users.posixUserdel`
 * (`LinuxUserManager.userdel`, message vendeur exact).
 */
export class UserdelCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'userdel',
    summary: 'Supprime un compte utilisateur',
    usage: 'userdel [-r] LOGIN',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-r LOGIN' },
    ],
    options: [],
    privileges: ROOT,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];

    let removeHome = false;
    let username = '';
    for (const a of args) {
      if (a === '-r') removeHome = true;
      else if (!a.startsWith('-')) username = a;
    }
    if (!username) {
      await ctx.io.stdout.write('userdel: missing username\n');
      return 1;
    }

    const result = ctx.machine.users.posixUserdel?.(username, removeHome) ?? '';
    if (result) {
      await ctx.io.stdout.write(result + '\n');
      return 1;
    }

    if (removeHome) {
      await ctx.io.stdout.write(`userdel: ${username} mail spool (/var/mail/${username}) not found\n`);
    }
    return EXIT_OK;
  }
}
