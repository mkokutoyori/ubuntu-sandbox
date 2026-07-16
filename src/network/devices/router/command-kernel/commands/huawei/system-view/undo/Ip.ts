import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiRouterUndoIpRouteStaticCommand } from './ip/RouteStatic';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `undo ip` (Huawei VRP, mode system-view) — commande COMPOSITE. Racine
 * des négations L3 globales (`undo ip route-static`, plus tard `undo ip
 * pool`, `undo ip host`, …).
 */
export class HuaweiRouterUndoIpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ip',
    summary: 'Negate an IP configuration',
    usage: 'undo ip <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['system-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiRouterUndoIpRouteStaticCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
