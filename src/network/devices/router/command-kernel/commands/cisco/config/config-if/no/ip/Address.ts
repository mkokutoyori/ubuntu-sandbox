import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { RouterMachineApi } from '../../../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `no ip address` (Cisco IOS, mode config-if) — commande FEUILLE
 * standalone. Retire l'IP primaire de l'interface sélectionnée.
 * Silence Cisco en cas de succès.
 */
export class CiscoRouterNoIpAddressCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'address',
    summary: 'Remove the interface IP address',
    usage: 'no ip address',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const iface = (ctx.session as CliSession).promptFields.get('selectedInterface');
    if (!iface) {
      await ctx.io.stderr.write('% No interface selected.\n');
      return 1;
    }
    if (!machine.router.clearInterfaceIp(iface)) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
