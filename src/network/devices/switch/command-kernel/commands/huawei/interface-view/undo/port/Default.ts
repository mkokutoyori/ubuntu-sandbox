import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiSwitchIfUndoPortDefaultVlanCommand } from './default/Vlan';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `undo port default` (Huawei VRP switch, interface-view) — commande
 * COMPOSITE. Aujourd'hui seule `undo port default vlan` est migrée.
 */
export class HuaweiSwitchIfUndoPortDefaultCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'default',
    summary: 'Negate a port default setting',
    usage: 'undo port default <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['interface-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiSwitchIfUndoPortDefaultVlanCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
