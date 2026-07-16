import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiRouterDisplayIpInterfaceCommand } from './ip/Interface';
import { HuaweiRouterDisplayIpRoutingTableCommand } from './ip/RoutingTable';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `display ip` (Huawei VRP routeur) — commande COMPOSITE. Racine des
 * commandes L3 côté display (`ip interface brief`, `ip routing-table`,
 * plus tard `ip pool`, `ip fib`, …). `display ip` seul est incomplete —
 * comportement identique au vrai VRP.
 */
export class HuaweiRouterDisplayIpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ip',
    summary: 'IP information',
    usage: 'display ip <subcommand>',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user-view', 'system-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiRouterDisplayIpInterfaceCommand());
    this.subRegistry.register(() => new HuaweiRouterDisplayIpRoutingTableCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
