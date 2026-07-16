import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiSwitchUndoVlanCommand } from './undo/Vlan';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `undo` (Huawei VRP switch, system-view) — commande COMPOSITE. Racine
 * des négations en system-view (`undo vlan <id>` pour l'instant, plus
 * tard `undo sysname`, `undo stp enable`, `undo dhcp enable`, …).
 */
export class HuaweiSwitchSysUndoCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'undo',
    summary: 'Negate a command / restore its default',
    usage: 'undo <command>',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['system-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiSwitchUndoVlanCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
