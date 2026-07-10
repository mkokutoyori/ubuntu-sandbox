import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { FileStat, toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

async function renderFormat(ctx: CommandContext, format: string, stat: FileStat): Promise<string> {
  const owner = (await ctx.machine.users.findByUid(stat.ownerUid))?.name ?? String(stat.ownerUid);
  const group = (await ctx.machine.groups.findByGid(stat.ownerGid))?.name ?? String(stat.ownerGid);
  const substitutions: Record<string, string> = {
    n: stat.path,
    s: String(stat.size),
    a: (stat.mode & 0o7777).toString(8),
    i: String(stat.inode),
    U: owner,
    G: group,
    F: stat.type,
    Y: String(Math.floor(stat.modifiedAt.getTime() / 1000)),
  };
  return format.replace(/%([a-zA-Z])/g, (whole, spec: string) => substitutions[spec] ?? whole);
}

export class StatCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'stat',
    summary: 'Affiche les métadonnées d\'un fichier',
    usage: 'stat [-c FORMAT] <fichier>',
    args: [{ name: 'target', type: 'path', required: true, description: 'fichier à inspecter' }],
    options: [
      { long: 'format', short: 'c', takesValue: true, type: 'string', description: 'format de sortie personnalisé' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const path = ctx.machine.fs.resolve(ctx.session.cwd, ctx.args.get<string>('target'));
    const stat = await ctx.machine.fs.stat(path, toFileSystemActor(ctx.session.user));

    if (ctx.args.has('format')) {
      await ctx.io.stdout.write((await renderFormat(ctx, ctx.args.get<string>('format'), stat)) + '\n');
      return EXIT_OK;
    }

    const octal = (stat.mode & 0o7777).toString(8).padStart(4, '0');
    const owner = (await ctx.machine.users.findByUid(stat.ownerUid))?.name ?? String(stat.ownerUid);
    const group = (await ctx.machine.groups.findByGid(stat.ownerGid))?.name ?? String(stat.ownerGid);
    const lines = [
      `  File: ${stat.path}`,
      `  Size: ${stat.size}\tBlocks: ${Math.ceil(stat.size / 512)}\tIO Block: 4096\t${stat.type}`,
      `Device: 0h/0d\tInode: ${stat.inode}\tLinks: ${stat.linkCount}`,
      `Access: (${octal})  Uid: (${stat.ownerUid}/${owner})   Gid: (${stat.ownerGid}/${group})`,
      `Modify: ${stat.modifiedAt.toISOString()}`,
    ];
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}
