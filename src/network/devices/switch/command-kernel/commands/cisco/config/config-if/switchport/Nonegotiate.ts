import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../../SwitchMachineApi';
import { broadcastInterfaces } from '../selected-interfaces';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `switchport nonegotiate` (Cisco Catalyst, config-if) — force le trunk
 *  sans DTP. */
export class CiscoSwitchportNonegotiateCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'nonegotiate',
    summary: 'Force trunk without DTP negotiation',
    usage: 'switchport nonegotiate',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const ifaces = broadcastInterfaces(ctx.session);
    if (ifaces.length === 0) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    for (const iface of ifaces) {
      if (!machine.switch.setInterfaceNonegotiate(iface, true)) {
        await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
        return 1;
      }
    }
    return EXIT_OK;
  }
}
