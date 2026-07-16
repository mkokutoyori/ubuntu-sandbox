import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../../../SwitchMachineApi';
import { broadcastInterfaces } from '../../selected-interfaces';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `switchport port-security maximum <n>` (Cisco Catalyst, config-if). */
export class CiscoSwitchPortSecurityMaximumCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'maximum',
    summary: 'Max secure addresses on the interface',
    usage: 'switchport port-security maximum <max>',
    args: [{ name: 'max', type: 'int', required: true, description: 'Max secure MAC addresses (1..)' }],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const ifaces = broadcastInterfaces(ctx.session);
    if (ifaces.length === 0) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    const max = ctx.args.get<number>('max');
    if (!Number.isInteger(max) || max < 1) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    for (const iface of ifaces) {
      if (!machine.switch.setInterfacePortSecurityMaximum(iface, max)) {
        await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
        return 1;
      }
    }
    return EXIT_OK;
  }
}
