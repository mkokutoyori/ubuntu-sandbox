import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiSwitchIfUndoPortDefaultCommand } from './port/Default';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `undo port` (Huawei VRP switch, interface-view) — commande COMPOSITE.
 * Aujourd'hui : `undo port default vlan` (remet le port en VLAN 1).
 */
export class HuaweiSwitchIfUndoPortCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'port',
    summary: 'Negate a port configuration',
    usage: 'undo port <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['interface-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiSwitchIfUndoPortDefaultCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
