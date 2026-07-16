import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoSwitchModeAccessCommand } from './mode/Access';
import { CiscoSwitchModeTrunkCommand } from './mode/Trunk';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `switchport mode` (Cisco Catalyst, config-if) — composite. */
export class CiscoSwitchportModeCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'mode',
    summary: 'Set trunking mode of the interface',
    usage: 'switchport mode <access | trunk>',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchModeAccessCommand());
    this.subRegistry.register(() => new CiscoSwitchModeTrunkCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
