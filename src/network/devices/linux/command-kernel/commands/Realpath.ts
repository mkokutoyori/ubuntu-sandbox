import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class RealpathCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'realpath',
    summary: 'Affiche le chemin absolu canonique d\'un fichier',
    usage: 'realpath [-q] [-m] <cible...>',
    args: [
      { name: 'targets', type: 'path', required: false, variadic: true, description: 'chemins à résoudre' },
    ],
    options: [
      { long: 'quiet', short: 'q', takesValue: false, description: 'aucun message d\'erreur' },
      { long: 'canonicalize-missing', short: 'm', takesValue: false, description: 'sans exiger l\'existence des composantes' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : ['.'];
    const quiet = ctx.args.flag('quiet');
    const requireFinal = !ctx.args.flag('canonicalize-missing');
    const actor = toFileSystemActor(ctx.session.user);

    const lines: string[] = [];
    let exitCode: ExitCode = 0;
    for (const target of targets) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, target);
      const resolved = await ctx.machine.fs.realpath?.(path, actor, requireFinal);
      if (!resolved) {
        exitCode = 1;
        if (!quiet) lines.push(`realpath: ${target}: No such file or directory`);
      } else {
        lines.push(resolved);
      }
    }

    await ctx.io.stdout.write(lines.length ? `${lines.join('\n')}\n` : '');
    return exitCode;
  }
}
