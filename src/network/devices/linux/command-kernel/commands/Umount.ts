import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `umount [options] target` — délègue à `machine.mountTable.umount`
 * (`handleUmount`, déjà public). Toujours réservé à root (contrairement à
 * `mount`, pas d'exemption de listing) — vérifié ici pour le message
 * vendeur exact.
 */
export class UmountCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'umount',
    summary: 'Démonte un système de fichiers',
    usage: 'umount [options] target',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'options, cible' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (!ctx.session.user.isRoot()) {
      await ctx.io.stdout.write('umount: only root can do that: Permission denied\n');
      return 1;
    }
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const { output, exitCode } = ctx.machine.mountTable!.umount(args);
    if (output) await ctx.io.stdout.write(output + '\n');
    return exitCode;
  }
}
