import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class CdCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'cd',
    aliases: ['chdir'],
    summary: 'Affiche ou change le répertoire de travail courant',
    usage: 'cd [/d] [répertoire]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'répertoire cible' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const targets = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (targets.length === 0) {
      await ctx.io.stdout.write(`${ctx.session.cwd}\n`);
      return EXIT_OK;
    }

    // `/d` is accepted but has no effect here — legacy cmdCd already allowed
    // crossing drives without it, so this mirrors that quirk rather than
    // real cmd.exe's stricter behaviour.
    const pathParts = targets[0].toLowerCase() === '/d' && targets.length > 1 ? targets.slice(1) : targets;
    const target = ctx.machine.fs.resolve(ctx.session.cwd, pathParts.join(' '));
    const actor = toFileSystemActor(ctx.session.user);

    // cmd.exe prints this error bare, with no "cd: " prefix — write it
    // directly instead of throwing a ShellError (which Executor prefixes
    // with the command name, matching bash's convention, not cmd's).
    try {
      const stat = await ctx.machine.fs.stat(target, actor);
      if (stat.type !== 'directory') {
        await ctx.io.stdout.write('The system cannot find the path specified.\n');
        return EXIT_OK;
      }
    } catch {
      await ctx.io.stdout.write('The system cannot find the path specified.\n');
      return EXIT_OK;
    }

    ctx.session.cwd = target;
    return EXIT_OK;
  }
}
