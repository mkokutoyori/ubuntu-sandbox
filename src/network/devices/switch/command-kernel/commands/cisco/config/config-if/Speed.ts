import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';
import { broadcastInterfaces } from './selected-interfaces';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

const VALID = new Set(['10', '100', '1000', 'auto']);

export class CiscoSwitchConfigIfSpeedCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'speed', summary: 'Set port speed', usage: 'speed {10|100|1000|auto}',
    args: [{ name: 'value', type: 'string', required: true, description: '10 | 100 | 1000 | auto' }],
    options: [], privileges: OP, category: 'switch',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const ifaces = broadcastInterfaces(ctx.session);
    if (ifaces.length === 0) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    const value = (ctx.args.get<string>('value') ?? '').toLowerCase();
    if (!VALID.has(value)) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    for (const iface of ifaces) {
      if (!machine.switch.setInterfaceSpeed(iface, value as '10' | '100' | '1000' | 'auto')) {
        await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
        return 1;
      }
    }
    return EXIT_OK;
  }
}
