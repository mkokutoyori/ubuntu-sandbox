import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';
import { broadcastInterfaces } from './selected-interfaces';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

export class CiscoSwitchConfigIfMtuCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'mtu', summary: 'IP MTU for the interface', usage: 'mtu <bytes>',
    args: [{ name: 'bytes', type: 'int', required: true, description: 'MTU (68-9216)' }],
    options: [], privileges: OP, category: 'switch',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const ifaces = broadcastInterfaces(ctx.session);
    if (ifaces.length === 0) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    const bytes = ctx.args.get<number>('bytes');
    for (const iface of ifaces) {
      if (!machine.switch.setInterfaceMtu(iface, bytes)) {
        await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
        return 1;
      }
    }
    return EXIT_OK;
  }
}
