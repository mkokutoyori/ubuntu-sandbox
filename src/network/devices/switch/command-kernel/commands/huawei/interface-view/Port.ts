import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiSwitchPortLinkTypeCommand } from './port/LinkType';
import { HuaweiSwitchPortDefaultCommand } from './port/Default';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `port` (Huawei VRP switch, interface-view) — commande COMPOSITE.
 * Racine des commandes de configuration du port L2 (`port link-type`,
 * `port default vlan`, plus tard `port trunk allow-pass vlan`,
 * `port hybrid tagged`, …). `port` seul est incomplete côté VRP.
 */
export class HuaweiSwitchIfPortCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'port',
    summary: 'Configure the switch port',
    usage: 'port <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['interface-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiSwitchPortLinkTypeCommand());
    this.subRegistry.register(() => new HuaweiSwitchPortDefaultCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
