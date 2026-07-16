import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoSwitchportAccessVlanCommand } from './access/Vlan';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `switchport access` (Cisco Catalyst, config-if) — composite. */
export class CiscoSwitchportAccessCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'access',
    summary: 'Set access mode characteristics of the interface',
    usage: 'switchport access <subcommand>',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchportAccessVlanCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
