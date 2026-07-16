import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoSwitchNoSwitchportNonegotiateCommand } from './switchport/Nonegotiate';
import { CiscoSwitchNoSwitchportVoiceCommand } from './switchport/Voice';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `no switchport` (config-if) — composite pour `no switchport
 *  nonegotiate` et `no switchport voice vlan`. */
export class CiscoSwitchNoSwitchportCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'switchport', summary: 'Negate switchport configuration',
    usage: 'no switchport {nonegotiate|voice vlan}',
    args: [], options: [], privileges: OP, category: 'switch',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchNoSwitchportNonegotiateCommand());
    this.subRegistry.register(() => new CiscoSwitchNoSwitchportVoiceCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
