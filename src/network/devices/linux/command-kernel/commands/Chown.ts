import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { UsageError } from '@/command-kernel/errors';
import { FileSystemActor, toFileSystemActor } from '@/command-kernel/machine/types';
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
    usage: 'chown [-R] <utilisateur>[:<groupe>] <fichier...>',
    args: [
      { name: 'owner', type: 'string', required: true, description: 'utilisateur[:groupe]' },
      { name: 'targets', type: 'path', required: true, variadic: true, description: 'fichiers cibles' },
    ],
    options: [
      { long: 'recursive', short: 'R', takesValue: false, description: 'applique récursivement aux répertoires' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const [ownerToken, groupToken] = ctx.args.get<string>('owner').split(':');
    const targets = ctx.args.get<string[]>('targets');
    const recursive = ctx.args.flag('recursive');
    const actor = toFileSystemActor(ctx.session.user);
    const uid = await resolveUid(ctx, ownerToken);
    const explicitGid = groupToken ? await resolveGid(ctx, groupToken) : undefined;
    for (const target of targets) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, target);
      await this.chownOne(ctx, path, actor, uid, explicitGid);
      if (recursive) await this.chownTree(ctx, path, actor, uid, explicitGid);
    }
    return EXIT_OK;
  }

  private async chownOne(
    ctx: CommandContext, path: string, actor: FileSystemActor, uid: number, explicitGid: number | undefined,
  ): Promise<void> {
    const current = await ctx.machine.fs.stat(path, actor);
    const gid = explicitGid ?? current.ownerGid;
    await ctx.machine.fs.chown(path, uid, gid, actor);
    ctx.machine.audit?.fsAccess(path, 'a', 'chown');
    ctx.machine.audit?.syscall('chown', path);
  }

  private async chownTree(
    ctx: CommandContext, dir: string, actor: FileSystemActor, uid: number, explicitGid: number | undefined,
  ): Promise<void> {
    const entries = await ctx.machine.fs.list(dir, actor).catch(() => []);
    for (const entry of entries) {
      await this.chownOne(ctx, entry.path, actor, uid, explicitGid);
      if (entry.type === 'directory') await this.chownTree(ctx, entry.path, actor, uid, explicitGid);
    }
  }
}
