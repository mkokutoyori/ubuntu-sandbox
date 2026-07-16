import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `no description` (Cisco Catalyst, mode config-if) — efface la
 *  description de l'interface sélectionnée. */
export class CiscoSwitchNoDescriptionCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'description',
    summary: 'Remove the interface description',
    usage: 'no description',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const iface = (ctx.session as CliSession).promptFields.get('selectedInterface');
    if (!iface) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    if (!machine.switch.setInterfaceDescription(iface, '')) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
