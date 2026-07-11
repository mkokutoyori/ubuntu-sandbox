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

async function resolveGid(ctx: CommandContext, token: string): Promise<number> {
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  const group = await ctx.machine.groups.findByName(token);
  if (!group) throw new UsageError(`groupe invalide : ${token}`);
  return group.gid;
}

export class ChownCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'chown',
    summary: 'Change le propriétaire (et le groupe) d\'un fichier',
    usage: 'chown <utilisateur>[:<groupe>] <fichier...>',
    args: [
      { name: 'owner', type: 'string', required: true, description: 'utilisateur[:groupe]' },
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
    const explicitGid = groupToken ? await resolveGid(ctx, groupToken) : undefined;
    for (const target of targets) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, target);
      const current = await ctx.machine.fs.stat(path, actor);
      const gid = explicitGid ?? current.ownerGid;
      await ctx.machine.fs.chown(path, uid, gid, actor);
      ctx.machine.audit?.fsAccess(path, 'a', 'chown');
      ctx.machine.audit?.syscall('chown', path);
    }
    return EXIT_OK;
  }
}
