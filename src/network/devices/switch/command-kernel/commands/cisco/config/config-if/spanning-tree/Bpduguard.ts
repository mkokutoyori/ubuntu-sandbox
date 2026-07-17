import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../../SwitchMachineApi';
import { broadcastInterfaces } from '../selected-interfaces';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

export class CiscoSwitchSpanningTreeBpduguardCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'bpduguard', summary: 'Enable/disable BPDU guard on portfast ports',
    usage: 'spanning-tree bpduguard {enable|disable}',
    args: [{ name: 'mode', type: 'string', required: true, description: 'enable | disable' }],
    options: [], privileges: OP, category: 'switch',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const ifaces = broadcastInterfaces(ctx.session);
    if (ifaces.length === 0) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    const mode = (ctx.args.get<string>('mode') ?? '').toLowerCase();
    if (mode !== 'enable' && mode !== 'disable') {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    for (const iface of ifaces) {
      if (!machine.switch.setInterfaceBpduguard(iface, mode === 'enable')) {
        await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
        return 1;
      }
    }
    return EXIT_OK;
  }
}
