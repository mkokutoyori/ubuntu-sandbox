import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiSwitchPortTrunkAllowCommand } from './trunk/Allow';
import { HuaweiSwitchPortTrunkPvidCommand } from './trunk/Pvid';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `port trunk` (Huawei VRP switch, interface-view) — COMPOSITE.
 * Sous-commandes VRP standard : `allow-pass`, `pvid`. Le port doit
 * généralement être en link-type `trunk` avant que ces commandes
 * aient un effet fonctionnel — la MachineApi laisse néanmoins passer
 * (le VRP réel stocke la config, elle prend effet quand le mode
 * bascule).
 */
export class HuaweiSwitchPortTrunkCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'trunk',
    summary: 'Configure the trunk port',
    usage: 'port trunk <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['interface-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiSwitchPortTrunkAllowCommand());
    this.subRegistry.register(() => new HuaweiSwitchPortTrunkPvidCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
