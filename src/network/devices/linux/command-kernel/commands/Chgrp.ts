import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { UsageError } from '@/command-kernel/errors';
import { FileSystemActor, toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

async function resolveGid(ctx: CommandContext, token: string): Promise<number> {
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  const group = await ctx.machine.groups.findByName(token);
  if (!group) throw new UsageError(`groupe invalide : ${token}`);
  return group.gid;
}

export class ChgrpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'chgrp',
    summary: 'Change le groupe propriétaire d\'un fichier',
    usage: 'chgrp [-R] <groupe> <fichier...>',
    args: [
      { name: 'group', type: 'string', required: true, description: 'groupe cible' },
      { name: 'targets', type: 'path', required: true, variadic: true, description: 'fichiers cibles' },
    ],
    options: [
      { long: 'recursive', short: 'R', takesValue: false, description: 'applique récursivement aux répertoires' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const groupToken = ctx.args.get<string>('group');
    const targets = ctx.args.get<string[]>('targets');
    const recursive = ctx.args.flag('recursive');
    const actor = toFileSystemActor(ctx.session.user);
    const gid = await resolveGid(ctx, groupToken);
    for (const target of targets) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, target);
      await this.chgrpOne(ctx, path, actor, gid);
      if (recursive) await this.chgrpTree(ctx, path, actor, gid);
    }
    return EXIT_OK;
  }

  private async chgrpOne(ctx: CommandContext, path: string, actor: FileSystemActor, gid: number): Promise<void> {
    const current = await ctx.machine.fs.stat(path, actor);
    await ctx.machine.fs.chown(path, current.ownerUid, gid, actor);
    ctx.machine.audit?.fsAccess(path, 'a', 'chgrp');
    ctx.machine.audit?.syscall('chgrp', path);
  }

  private async chgrpTree(ctx: CommandContext, dir: string, actor: FileSystemActor, gid: number): Promise<void> {
    const entries = await ctx.machine.fs.list(dir, actor).catch(() => []);
    for (const entry of entries) {
      await this.chgrpOne(ctx, entry.path, actor, gid);
      if (entry.type === 'directory') await this.chgrpTree(ctx, entry.path, actor, gid);
    }
  }
}
