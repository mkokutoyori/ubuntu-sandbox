import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class GroupsCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'groups',
    summary: 'Affiche les groupes d\'un utilisateur',
    usage: 'groups [utilisateur]',
    args: [{ name: 'username', type: 'string', required: false, description: 'utilisateur cible (défaut : courant)' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'session',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const explicit = ctx.args.has('username');
    const target = explicit ? ctx.args.get<string>('username') : ctx.session.user.name;
    const user = await ctx.machine.users.findByName(target);
    if (!user) {
      await ctx.io.stdout.write(`groups: '${target}': no such user\n`);
      return EXIT_OK;
    }
    const names = [...user.groups].join(' ');
    const out = explicit ? `${target} : ${names}` : names;
    await ctx.io.stdout.write(out + '\n');
    return EXIT_OK;
  }
}
