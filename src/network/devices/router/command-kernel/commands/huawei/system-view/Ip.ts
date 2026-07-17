import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiRouterIpRouteStaticCommand } from './ip/RouteStatic';
import { HuaweiRouterSysIpPoolCommand } from './ip/Pool';
import { HuaweiRouterSysIpVpnInstanceCommand } from './ip/VpnInstance';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `ip` (Huawei VRP, mode system-view) — commande COMPOSITE. Racine
 * des commandes L3 globales du routeur (`ip route-static`, plus tard
 * `ip pool`, `ip host`, `ip name-server`, …). `ip` seul renvoie
 * « Incomplete » — comportement identique au vrai VRP.
 *
 * ATTENTION : distinct du `ip` d'interface-view (interface-scope) — les
 * deux modes ont leur propre registre.
 */
export class HuaweiRouterSysIpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ip',
    summary: 'Global IP configuration',
    usage: 'ip <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['system-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiRouterIpRouteStaticCommand());
    this.subRegistry.register(() => new HuaweiRouterSysIpPoolCommand());
    this.subRegistry.register(() => new HuaweiRouterSysIpVpnInstanceCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
