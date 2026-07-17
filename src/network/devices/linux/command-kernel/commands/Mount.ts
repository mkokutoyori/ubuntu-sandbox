import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `mount [options] [source] [target]` — délègue à `machine.mountTable.mount`
 * (`handleMount`, déjà public, contre la vraie `MountTable`). Bare `mount`/
 * `mount -l` (listing) ne requiert aucun privilège, comme le vrai `mount` ;
 * toute autre forme exige root — vérifié ici (le gestionnaire legacy ne
 * porte pas cette exemption conditionnelle lui-même).
 */
export class MountCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'mount',
    summary: 'Monte un système de fichiers ou liste les montages',
    usage: 'mount [options] [source] [target]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'options, source, cible' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const listOnly = args.length === 0 || (args.length === 1 && args[0] === '-l');
    if (!listOnly && !ctx.session.user.isRoot()) {
      await ctx.io.stdout.write('mount: only root can do that: Permission denied\n');
      return 1;
    }
    const { output, exitCode } = ctx.machine.mountTable!.mount(args);
    if (output) await ctx.io.stdout.write(output + '\n');
    return exitCode;
  }
}
