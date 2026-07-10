import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { UsageError } from '@/command-kernel/errors';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

async function resolveUid(ctx: CommandContext, token: string): Promise<number> {
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  const user = await ctx.machine.users.findByName(token);
  if (!user) throw new UsageError(`utilisateur invalide : ${token}`);
  return user.uid;
}

export class ChownCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'chown',
    summary: 'Change le propriétaire (et le groupe) d\'un fichier',
    usage: 'chown <utilisateur>[:<gid>] <fichier...>',
    args: [
      { name: 'owner', type: 'string', required: true, description: 'utilisateur[:gid]' },
      { name: 'targets', type: 'path', required: true, variadic: true, description: 'fichiers cibles' },
    ],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const [ownerToken, groupToken] = ctx.args.get<string>('owner').split(':');
    const targets = ctx.args.get<string[]>('targets');
    const actor = toFileSystemActor(ctx.session.user);
    const uid = await resolveUid(ctx, ownerToken);
    if (groupToken && !/^\d+$/.test(groupToken)) {
      throw new UsageError(`gid invalide : ${groupToken}`);
    }
    for (const target of targets) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, target);
      const current = await ctx.machine.fs.stat(path, actor);
      const gid = groupToken ? parseInt(groupToken, 10) : current.ownerGid;
      await ctx.machine.fs.chown(path, uid, gid, actor);
    }
    return EXIT_OK;
  }
}
