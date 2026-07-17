import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ROOT = new DefaultPrivilegePolicy(PrivilegeLevel.ROOT);

/**
 * `deluser [options] LOGIN [GROUP]` — alias Debian de `userdel`, avec une
 * forme secondaire `deluser USER GROUP` qui retire seulement l'appartenance
 * (délègue à `machine.groups.posixRemoveMember`). Bannière de progression
 * identique à `handleDeluser`.
 */
export class DeluserCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'deluser',
    summary: 'Supprime un compte utilisateur (alias Debian de userdel)',
    usage: 'deluser [options] LOGIN [GROUP]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '--remove-home LOGIN [GROUP]' },
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
    let fromGroup = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--remove-home') { removeHome = true; continue; }
      if (!args[i].startsWith('-')) {
        if (!username) username = args[i];
        else fromGroup = args[i];
      }
    }
    if (!username) {
      await ctx.io.stdout.write('deluser: missing username\n');
      return 1;
    }

    if (fromGroup) {
      const result = ctx.machine.groups.posixRemoveMember?.(fromGroup, username) ?? '';
      if (result) {
        await ctx.io.stdout.write(result + '\n');
        return 1;
      }
      await ctx.io.stdout.write(`Removing user \`${username}' from group \`${fromGroup}' ...\nDone.\n`);
      return EXIT_OK;
    }

    const result = ctx.machine.users.posixUserdel?.(username, removeHome) ?? '';
    if (result) {
      await ctx.io.stdout.write(result + '\n');
      return 1;
    }

    const lines: string[] = [];
    if (removeHome) {
      lines.push('Looking for files to backup/remove ...');
      lines.push('Removing files ...');
    }
    lines.push(`Removing user \`${username}' ...`);
    lines.push('Done.');
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}
