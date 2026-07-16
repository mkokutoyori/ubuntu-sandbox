import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import {
  CiscoSwitchTrunkEncapDot1qCommand,
  CiscoSwitchTrunkEncapIslCommand,
  CiscoSwitchTrunkEncapNegotiateCommand,
} from './encapsulation/encapsulation-leaves';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `switchport trunk encapsulation` (composite → dot1q | isl | negotiate). */
export class CiscoSwitchTrunkEncapsulationCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'encapsulation',
    summary: 'Set trunking encapsulation',
    usage: 'switchport trunk encapsulation {dot1q|isl|negotiate}',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchTrunkEncapDot1qCommand());
    this.subRegistry.register(() => new CiscoSwitchTrunkEncapIslCommand());
    this.subRegistry.register(() => new CiscoSwitchTrunkEncapNegotiateCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
