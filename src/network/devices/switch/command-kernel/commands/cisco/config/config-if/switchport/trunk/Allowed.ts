import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoSwitchTrunkAllowedVlanCommand } from './allowed/Vlan';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `switchport trunk allowed` (Cisco Catalyst, config-if) — composite. */
export class CiscoSwitchTrunkAllowedCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'allowed',
    summary: 'Set allowed characteristics when interface is in trunking mode',
    usage: 'switchport trunk allowed vlan {all | none | <list> | add <list> | remove <list> | except <list>}',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchTrunkAllowedVlanCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
