import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { formatKbHuman } from '@/network/devices/linux/LinuxSystemCommands';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);
const VALID_FLAGS = new Set([
  '-h', '--human-readable', '-i', '-T', '--print-type', '-a', '--all',
  '-H', '-k', '-m', '-l', '--local', '-P', '--portability', '-B', '--block-size',
]);

interface Row { fs: string; type: string; sizeKb: number; usedKb: number; availKb: number; usePct: number; mount: string; }

async function countInodes(ctx: CommandContext, actor: ReturnType<typeof toFileSystemActor>, path: string): Promise<number> {
  let count = 1;
  let entries;
  try { entries = await ctx.machine.fs.list(path, actor); } catch { return count; }
  for (const e of entries) {
    count += e.type === 'directory' ? await countInodes(ctx, actor, e.path) : 1;
  }
  return count;
}

/** `df [options] [fichier...]` — utilisation des montages via `machine.diskUsage`. */
export class DfCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'df',
    summary: 'Affiche l\'utilisation des systèmes de fichiers montés',
    usage: 'df [options] [fichier...]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-h/-i/-T/-a/-t/-x, cibles' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const human = args.includes('-h') || args.includes('--human-readable');
    const inodes = args.includes('-i');
    let showType = args.includes('-T') || args.includes('--print-type');
    const all = args.includes('-a') || args.includes('--all');

    const includeTypes: string[] = [];
    const excludeTypes: string[] = [];
    const targets: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-t' || a === '--type') { includeTypes.push(args[++i] ?? ''); continue; }
      if (a === '-x' || a === '--exclude-type') { excludeTypes.push(args[++i] ?? ''); continue; }
      if (a.startsWith('-')) {
        if (!VALID_FLAGS.has(a)) {
          if (/^-h+$/.test(a) && a.length > 2) { await ctx.io.stdout.write(`df: invalid option -- '${a.slice(1)}'\n`); return EXIT_OK; }
          await ctx.io.stdout.write(`df: invalid option -- '${a.replace(/^-+/, '')}'\n`);
          return EXIT_OK;
        }
        continue;
      }
      targets.push(a);
    }

    const actor = toFileSystemActor(ctx.session.user);
    for (const t of targets) {
      const abs = ctx.machine.fs.resolve(ctx.session.cwd, t);
      if (!(await ctx.machine.fs.exists(abs, actor))) {
        await ctx.io.stdout.write(`df: ${t}: No such file or directory\n`);
        return EXIT_OK;
      }
    }

    if (includeTypes.length > 0) showType = true;
    const rawRows = ctx.machine.diskUsage!.entries(all);
    let rows: Row[] = rawRows.map((r) => ({
      fs: r.fs, type: r.type, sizeKb: r.sizeKb, usedKb: r.usedKb, availKb: r.availKb, usePct: r.usePct, mount: r.mountPoint,
    }));

    if (includeTypes.length > 0) {
      rows = rows.filter((r) => includeTypes.includes(r.type));
      if (rows.length === 0) { await ctx.io.stdout.write('df: no file systems processed\n'); return EXIT_OK; }
    }
    if (excludeTypes.length > 0) rows = rows.filter((r) => !excludeTypes.includes(r.type));
    if (!all) rows = rows.filter((r) => !(r.fs === 'tmpfs' && r.usedKb === 0));
    if (targets.length > 0) {
      const annotated = targets.map((t) => {
        const tp = ctx.machine.fs.resolve(ctx.session.cwd, t);
        let best: Row | undefined;
        for (const r of rows) {
          if (tp === r.mount || tp.startsWith(r.mount === '/' ? '/' : `${r.mount}/`)) {
            if (!best || r.mount.length > best.mount.length) best = r;
          }
        }
        return best ? { ...best, mount: tp } : null;
      }).filter((r): r is Row => r !== null);
      rows = annotated;
    }

    if (showType) {
      const header = human
        ? 'Filesystem     Type     Size  Used Avail Use% Mounted on'
        : 'Filesystem     Type    1K-blocks     Used Available Use% Mounted on';
      const lines = rows.map((r) => human
        ? `${r.fs.padEnd(15)} ${r.type.padEnd(8)} ${formatKbHuman(r.sizeKb).padStart(4)} ${formatKbHuman(r.usedKb).padStart(5)} ${formatKbHuman(r.availKb).padStart(5)} ${String(r.usePct).padStart(3)}% ${r.mount}`
        : `${r.fs.padEnd(15)} ${r.type.padEnd(7)} ${String(r.sizeKb).padStart(9)} ${String(r.usedKb).padStart(8)} ${String(r.availKb).padStart(9)} ${String(r.usePct).padStart(3)}% ${r.mount}`);
      await ctx.io.stdout.write([header, ...lines].join('\n') + '\n');
      return EXIT_OK;
    }

    if (inodes) {
      const rootInodes = await countInodes(ctx, actor, '/');
      const rootInodeCap = 655_360;
      const rootInodeFree = Math.max(0, rootInodeCap - rootInodes);
      const rootInodePct = Math.min(100, Math.ceil((rootInodes / rootInodeCap) * 100));
      await ctx.io.stdout.write([
        'Filesystem      Inodes  IUsed   IFree IUse% Mounted on',
        `/dev/sda1       ${String(rootInodeCap).padStart(6)}  ${String(rootInodes).padStart(5)}  ${String(rootInodeFree).padStart(6)}  ${String(rootInodePct).padStart(3)}% /`,
        'tmpfs           127960      1  127959    1% /dev/shm',
        '/dev/sda2       131072   2145  128927    2% /boot',
      ].join('\n') + '\n');
      return EXIT_OK;
    }

    const header = human
      ? 'Filesystem      Size  Used Avail Use% Mounted on'
      : 'Filesystem     1K-blocks     Used Available Use% Mounted on';
    const lines = rows.map((r) => human
      ? `${r.fs.padEnd(15)} ${formatKbHuman(r.sizeKb).padStart(4)} ${formatKbHuman(r.usedKb).padStart(5)} ${formatKbHuman(r.availKb).padStart(5)} ${String(r.usePct).padStart(3)}% ${r.mount}`
      : `${r.fs.padEnd(15)} ${String(r.sizeKb).padStart(9)} ${String(r.usedKb).padStart(8)} ${String(r.availKb).padStart(9)} ${String(r.usePct).padStart(3)}% ${r.mount}`);
    await ctx.io.stdout.write([header, ...lines].join('\n') + '\n');
    return EXIT_OK;
  }
}
