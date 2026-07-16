import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `undo shutdown` (Huawei VRP, mode interface-view) — commande FEUILLE
 * standalone. Passe l'interface sélectionnée en admin-up. Silence VRP
 * en cas de succès.
 */
export class HuaweiRouterIfUndoShutdownCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'shutdown',
    summary: 'Enable the selected interface',
    usage: 'undo shutdown',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['interface-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const iface = (ctx.session as CliSession).promptFields.get('selectedInterface');
    if (!iface) {
      await ctx.io.stderr.write("Error: No interface selected.\n");
      return 1;
    }
    if (!machine.router.setInterfaceAdminUp(iface, true)) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
