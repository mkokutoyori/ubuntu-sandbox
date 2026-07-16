import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { RouterMachineApi } from '../../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `no shutdown` (Cisco IOS, mode config-if) — commande FEUILLE
 * standalone. Passe l'interface sélectionnée en admin-up. Silence
 * Cisco en cas de succès.
 */
export class CiscoRouterNoShutdownCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'shutdown',
    summary: 'Enable the selected interface',
    usage: 'no shutdown',
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
    if (!machine.router.setInterfaceAdminUp(iface, true)) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
