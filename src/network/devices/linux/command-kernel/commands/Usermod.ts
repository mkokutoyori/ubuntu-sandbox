import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ROOT = new DefaultPrivilegePolicy(PrivilegeLevel.ROOT);

/**
 * `usermod [options] LOGIN` — délègue à `machine.users.posixUsermod`
 * (`LinuxUserManager.usermod`, message vendeur exact), parsing des options
 * reproduit à l'identique de `cmdUsermod`.
 */
export class UsermodCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'usermod',
    summary: 'Modifie un compte utilisateur existant',
    usage: 'usermod [options] LOGIN',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-s/-d/-m/-aG/-L/-U LOGIN' },
    ],
    options: [],
    privileges: ROOT,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];

    let shell: string | undefined, home: string | undefined, moveHome = false;
    let appendToGroup: string | undefined, lock = false, unlock = false;
    let username = '';

    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case '-s': case '--shell': shell = args[++i]; break;
        case '-d': case '--home': home = args[++i]; break;
        case '-m': case '--move-home': moveHome = true; break;
        case '-aG': appendToGroup = args[++i]; break;
        case '-G': case '--groups': appendToGroup = args[++i]; break;
        case '-L': case '--lock': lock = true; break;
        case '-U': case '--unlock': unlock = true; break;
        default:
          if (!args[i].startsWith('-')) username = args[i];
          break;
      }
    }

    if (!username) {
      await ctx.io.stdout.write('usermod: missing username\n');
      return 1;
    }

    const result = ctx.machine.users.posixUsermod?.(username, {
      shell, home, moveHome, appendToGroup, lock, unlock,
    }) ?? '';
    if (result) {
      await ctx.io.stdout.write(result + '\n');
      return 1;
    }
    return EXIT_OK;
  }
}
