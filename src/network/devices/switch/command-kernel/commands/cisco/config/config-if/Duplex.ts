import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';
import { broadcastInterfaces } from './selected-interfaces';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

const VALID = new Set(['half', 'full', 'auto']);

export class CiscoSwitchConfigIfDuplexCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'duplex', summary: 'Set duplex mode', usage: 'duplex {half|full|auto}',
    args: [{ name: 'mode', type: 'string', required: true, description: 'half | full | auto' }],
    options: [], privileges: OP, category: 'switch',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const ifaces = broadcastInterfaces(ctx.session);
    if (ifaces.length === 0) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    const mode = (ctx.args.get<string>('mode') ?? '').toLowerCase();
    if (!VALID.has(mode)) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    for (const iface of ifaces) {
      if (!machine.switch.setInterfaceDuplex(iface, mode as 'half' | 'full' | 'auto')) {
        await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
        return 1;
      }
    }
    return EXIT_OK;
  }
}
