import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoRouterIpRouteCommand } from './ip/Route';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `ip` (Cisco IOS, mode config) — commande COMPOSITE. Racine des
 * commandes L3 globales du routeur (`ip route`, plus tard `ip
 * routing`, `ip access-list`, `ip name-server`, …). `ip` seul renvoie
 * « Incomplete command. » comme le vrai IOS.
 *
 * ATTENTION : distinct du `ip` de config-if (interface-scope). Chaque
 * mode a son propre registre — la même racine `ip` porte des
 * sous-commandes différentes selon le mode.
 */
export class CiscoRouterConfigIpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ip',
    summary: 'Global IP configuration',
    usage: 'ip <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoRouterIpRouteCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
