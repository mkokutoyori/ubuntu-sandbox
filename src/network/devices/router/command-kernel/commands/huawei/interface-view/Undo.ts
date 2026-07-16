import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiRouterIfUndoShutdownCommand } from './undo/Shutdown';
import { HuaweiRouterIfUndoDescriptionCommand } from './undo/Description';
import { HuaweiRouterIfUndoIpCommand } from './undo/Ip';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `undo` (Huawei VRP, mode interface-view) — commande COMPOSITE. Racine
 * des négations à l'interface (`undo shutdown`, `undo description`,
 * `undo ip address`, plus tard `undo mtu`, `undo ip binding`, …).
 */
export class HuaweiRouterIfUndoCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'undo',
    summary: 'Negate a command / restore its default',
    usage: 'undo <command>',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['interface-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiRouterIfUndoShutdownCommand());
    this.subRegistry.register(() => new HuaweiRouterIfUndoDescriptionCommand());
    this.subRegistry.register(() => new HuaweiRouterIfUndoIpCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
