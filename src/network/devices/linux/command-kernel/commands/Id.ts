import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class IdCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'id',
    summary: 'Affiche l\'identité (uid/gid/groupes) d\'un utilisateur',
    usage: 'id [-u|-g|-G] [-n] [-r] [utilisateur]',
    args: [{ name: 'username', type: 'string', required: false, description: 'utilisateur cible (défaut : courant)' }],
    options: [
      { long: 'user', short: 'u', takesValue: false, description: 'affiche uniquement l\'uid' },
      { long: 'group', short: 'g', takesValue: false, description: 'affiche uniquement le gid' },
      { long: 'groups', short: 'G', takesValue: false, description: 'affiche tous les gids' },
      { long: 'name', short: 'n', takesValue: false, description: 'affiche des noms plutôt que des identifiants' },
      { long: 'real', short: 'r', takesValue: false, description: 'identifiant réel plutôt qu\'effectif' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'session',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const username = ctx.args.has('username') ? ctx.args.get<string>('username') : ctx.session.user.name;
    const user = await ctx.machine.users.findByName(username);
    if (!user) {
      await ctx.io.stdout.write(`id: '${username}': no such user\n`);
      return 1;
    }

    const u = ctx.args.flag('user');
    const g = ctx.args.flag('group');
    const G = ctx.args.flag('groups');
    const n = ctx.args.flag('name');
    const r = ctx.args.flag('real');
    const selectors = [u, g, G].filter(Boolean).length;

    const primaryGroup = await ctx.machine.groups.findByGid(user.gid);
    const groupEntries: Array<{ gid: number; name: string }> = [];
    for (const name of user.groups) {
      const entry = await ctx.machine.groups.findByName(name);
      if (entry) groupEntries.push(entry);
    }

    if (selectors === 0) {
      if (n || r) {
        await ctx.io.stdout.write('id: cannot print only names or real IDs in default format\n');
        return EXIT_OK;
      }
      const groupsStr = groupEntries.map((e) => `${e.gid}(${e.name})`).join(',');
      await ctx.io.stdout.write(
        `uid=${user.uid}(${user.name}) gid=${user.gid}(${primaryGroup?.name ?? user.gid}) groups=${groupsStr}\n`,
      );
      return EXIT_OK;
    }
    if (selectors > 1) {
      await ctx.io.stdout.write('id: cannot print "only" of more than one choice\n');
      return EXIT_OK;
    }

    let out: string;
    if (u) out = n ? user.name : String(user.uid);
    else if (g) out = n ? (primaryGroup?.name ?? String(user.gid)) : String(user.gid);
    else out = groupEntries.map((e) => (n ? e.name : String(e.gid))).join(' ');
    await ctx.io.stdout.write(out + '\n');
    return EXIT_OK;
  }
}
