import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoSwitchNoSwitchportVoiceVlanCommand } from './voice/Vlan';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

export class CiscoSwitchNoSwitchportVoiceCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'voice', summary: 'Remove voice configuration',
    usage: 'no switchport voice vlan',
    args: [], options: [], privileges: OP, category: 'switch',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchNoSwitchportVoiceVlanCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
