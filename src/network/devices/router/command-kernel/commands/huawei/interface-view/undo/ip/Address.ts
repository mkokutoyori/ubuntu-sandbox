import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { RouterMachineApi } from '../../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `undo ip address` (Huawei VRP, mode interface-view) — commande
 * FEUILLE standalone. Retire l'IP primaire de l'interface sélectionnée
 * via `RouterMachineApi.router.clearInterfaceIp`.
 */
export class HuaweiRouterIfUndoIpAddressCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'address',
    summary: 'Remove the IP address of the interface',
    usage: 'undo ip address',
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
    if (!machine.router.clearInterfaceIp(iface)) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
