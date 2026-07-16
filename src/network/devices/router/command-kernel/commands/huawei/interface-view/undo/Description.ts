import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `undo description` (Huawei VRP, mode interface-view) — commande
 * FEUILLE standalone. Retire la description libre de l'interface
 * sélectionnée (setter avec chaîne vide côté MachineApi).
 */
export class HuaweiRouterIfUndoDescriptionCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'description',
    summary: 'Remove the interface description',
    usage: 'undo description',
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
    if (!machine.router.setInterfaceDescription(iface, '')) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
