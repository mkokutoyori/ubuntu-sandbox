import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { formatBytesHuman } from '@/network/devices/linux/LinuxSystemCommands';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** `du [options] [fichier...]` — taille récursive via `machine.directoryUsage`/`machine.fs`. */
export class DuCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'du',
    summary: 'Affiche la taille d\'utilisation disque d\'une arborescence',
    usage: 'du [options] [fichier...]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-s/-h/-b, cible' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const rawArgs = ctx.args.get<string[] | undefined>('rest') ?? [];
    const expand = (a: string): string[] => {
      if (!a.startsWith('-') || a.startsWith('--') || a.length <= 2) return [a];
      return a.slice(1).split('').map((c) => `-${c}`);
    };
    const args = rawArgs.flatMap(expand);
    const human = args.includes('-h') || args.includes('--human-readable');
    const summary = args.includes('-s') || args.includes('--summarize');
    const bytesFlag = args.includes('-b') || args.includes('--bytes');
    const targets = args.filter((a) => !a.startsWith('-'));
    const target = targets[targets.length - 1] ?? '.';
    const actor = toFileSystemActor(ctx.session.user);
    const absPath = ctx.machine.fs.resolve(ctx.session.cwd, target);

    if (!(await ctx.machine.fs.exists(absPath, actor))) {
      await ctx.io.stdout.write(`du: cannot access '${target}': No such file or directory\n`);
      return EXIT_OK;
    }

    const fmt = (bytes: number): string => {
      if (bytesFlag) return String(bytes);
      if (human) return formatBytesHuman(bytes);
      return String(Math.max(1, Math.ceil(bytes / 1024)));
    };

    const node = await ctx.machine.fs.lstat(absPath, actor).catch(() => null);
    if (!node) {
      await ctx.io.stdout.write(`du: cannot access '${target}': No such file or directory\n`);
      return EXIT_OK;
    }

    if (node.type !== 'directory') {
      await ctx.io.stdout.write(`${fmt(node.size)}\t${target}\n`);
      return EXIT_OK;
    }

    const entries = ctx.machine.directoryUsage!.walk(absPath, target);
    if (summary) {
      const total = entries.length > 0 ? entries[entries.length - 1].bytes : 0;
      await ctx.io.stdout.write(`${fmt(total)}\t${target}\n`);
      return EXIT_OK;
    }

    await ctx.io.stdout.write(entries.map((e) => `${fmt(e.bytes)}\t${e.path}`).join('\n') + '\n');
    return EXIT_OK;
  }
}
