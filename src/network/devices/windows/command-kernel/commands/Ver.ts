import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { WIN_VER_STRING } from '../../WindowsVersion';

export class VerCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ver',
    summary: 'Affiche la version de Windows',
    usage: 'ver',
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    // Constante partagée avec `WindowsPC.runSyncNativeCommand` (le shim
    // PowerShell), pas une copie — cmd et PowerShell doivent rapporter
    // exactement le même build (§ cmd-ps-coherence.test.ts).
    await ctx.io.stdout.write(WIN_VER_STRING + '\n');
    return EXIT_OK;
  }
}
