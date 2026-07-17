import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

function synthUuid(seed: string): string {
  let h = 0;
  for (const c of seed) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  const u = (h >>> 0).toString(16).padStart(8, '0');
  return `${u}-${u.slice(0, 4)}-${u.slice(4, 8)}-${u.slice(0, 4)}-${u}${u.slice(0, 4)}`;
}

/** `blkid [options] [périphérique...]` — métadonnées de partitions via `machine.diskPartitions`. */
export class BlkidCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'blkid',
    summary: 'Affiche les identifiants de systèmes de fichiers des partitions',
    usage: 'blkid [options] [périphérique...]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-h/-V, périphériques' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (!ctx.session.user.isRoot()) {
      await ctx.io.stdout.write('blkid: error: Permission denied\n');
      return EXIT_OK;
    }

    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const targets: string[] = [];
    for (const a of args) {
      if (a === '-h' || a === '--help') {
        await ctx.io.stdout.write([
          'Usage:',
          ' blkid -L <label> | -U <uuid>',
          ' blkid [-o <format>] [-s <tag>] [--match-token <NAME=value>] [--match-tag <tag>]',
          '       [<dev> ...]',
        ].join('\n') + '\n');
        return EXIT_OK;
      }
      if (a === '-V' || a === '--version') {
        await ctx.io.stdout.write('blkid from util-linux 2.37\n');
        return EXIT_OK;
      }
      if (a.startsWith('-')) {
        await ctx.io.stdout.write(`blkid: unrecognized option '${a}'\n`);
        return EXIT_OK;
      }
      targets.push(a);
    }

    const all = ctx.machine.diskPartitions!.list();
    const matches = targets.length === 0
      ? all
      : all.filter((p) => targets.includes(`/dev/${p.name}`));

    if (targets.length > 0 && matches.length === 0) {
      await ctx.io.stdout.write(`blkid: error: ${targets[0]}: No such file or directory\n`);
      return EXIT_OK;
    }

    const lines = matches.map((p) => {
      const uuid = p.uuid || synthUuid(p.name);
      return `/dev/${p.name}: UUID="${uuid}" TYPE="${p.fsType}" PARTUUID="${synthUuid(`part-${p.name}`)}"`;
    });
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}
