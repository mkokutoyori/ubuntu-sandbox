import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../../../../SwitchMachineApi';
import { broadcastInterfaces } from '../../../selected-interfaces';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** Base commune pour les feuilles `dot1q | isl | negotiate`. */
abstract class TrunkEncapLeafBase extends BaseCommand {
  protected abstract readonly type: 'dot1q' | 'isl' | 'negotiate';

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const ifaces = broadcastInterfaces(ctx.session);
    if (ifaces.length === 0) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    for (const iface of ifaces) {
      if (!machine.switch.setInterfaceTrunkEncapsulation(iface, this.type)) {
        await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
        return 1;
      }
    }
    return EXIT_OK;
  }
}

export class CiscoSwitchTrunkEncapDot1qCommand extends TrunkEncapLeafBase {
  protected readonly type = 'dot1q';
  readonly descriptor: CommandDescriptor = {
    name: 'dot1q', summary: 'IEEE 802.1Q encapsulation',
    usage: 'switchport trunk encapsulation dot1q',
    args: [], options: [], privileges: OP, category: 'switch',
  };
  readonly allowedModes = ['config-if'];
}

export class CiscoSwitchTrunkEncapIslCommand extends TrunkEncapLeafBase {
  protected readonly type = 'isl';
  readonly descriptor: CommandDescriptor = {
    name: 'isl', summary: 'ISL encapsulation',
    usage: 'switchport trunk encapsulation isl',
    args: [], options: [], privileges: OP, category: 'switch',
  };
  readonly allowedModes = ['config-if'];
}

export class CiscoSwitchTrunkEncapNegotiateCommand extends TrunkEncapLeafBase {
  protected readonly type = 'negotiate';
  readonly descriptor: CommandDescriptor = {
    name: 'negotiate', summary: 'Negotiate encapsulation via DTP',
    usage: 'switchport trunk encapsulation negotiate',
    args: [], options: [], privileges: OP, category: 'switch',
  };
  readonly allowedModes = ['config-if'];
}
