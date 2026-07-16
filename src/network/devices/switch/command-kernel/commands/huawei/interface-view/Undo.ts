import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiSwitchIfUndoShutdownCommand } from './undo/Shutdown';
import { HuaweiSwitchIfUndoDescriptionCommand } from './undo/Description';
import { HuaweiSwitchIfUndoPortCommand } from './undo/Port';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `undo` (Huawei VRP switch, interface-view) — commande COMPOSITE.
 * Racine des négations à l'interface (`undo shutdown`, `undo
 * description`, `undo port default vlan`, plus tard `undo port
 * link-type`, `undo mtu`, …).
 */
export class HuaweiSwitchIfUndoCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'undo',
    summary: 'Negate a command / restore its default',
    usage: 'undo <command>',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['interface-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiSwitchIfUndoShutdownCommand());
    this.subRegistry.register(() => new HuaweiSwitchIfUndoDescriptionCommand());
    this.subRegistry.register(() => new HuaweiSwitchIfUndoPortCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
