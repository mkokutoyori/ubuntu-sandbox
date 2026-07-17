import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { cmdRunlevel } from '@/network/devices/linux/system/SystemInfo';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** `runlevel` — délègue à `cmdRunlevel`, fonction pure ; `machine.netstat.isServer()` (déjà exposé) fournit le seul état nécessaire. */
export class RunlevelCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'runlevel',
    summary: 'Affiche le niveau d\'exécution précédent et courant',
    usage: 'runlevel',
    args: [],
    options: [],
    privileges: ANY,
    category: 'linux',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stdout.write(`${cmdRunlevel(ctx.machine.netstat!.isServer())}\n`);
    return EXIT_OK;
  }
}
