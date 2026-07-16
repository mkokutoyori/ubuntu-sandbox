import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoSwitchTrunkAllowedCommand } from './trunk/Allowed';
import { CiscoSwitchTrunkNativeCommand } from './trunk/Native';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `switchport trunk` (Cisco Catalyst, config-if) — composite pour
 *  `native vlan <id>` et `allowed vlan ...`. */
export class CiscoSwitchportTrunkCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'trunk',
    summary: 'Set trunking characteristics of the interface',
    usage: 'switchport trunk <subcommand>',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchTrunkNativeCommand());
    this.subRegistry.register(() => new CiscoSwitchTrunkAllowedCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
