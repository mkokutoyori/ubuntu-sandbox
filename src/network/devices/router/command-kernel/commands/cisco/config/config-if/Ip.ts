import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoRouterIpAddressCommand } from './ip/Address';
import { CiscoRouterConfigIfIpAccessGroupCommand } from './ip/AccessGroup';
import { CiscoRouterConfigIfIpHelperAddressCommand } from './ip/HelperAddress';
import { CiscoRouterConfigIfIpNatCommand } from './ip/Nat';
import { CiscoRouterConfigIfIpProxyArpCommand } from './ip/ProxyArp';
import { CiscoRouterConfigIfIpRedirectsCommand } from './ip/Redirects';
import { CiscoRouterConfigIfIpUnreachablesCommand } from './ip/Unreachables';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `ip` (Cisco IOS, mode config-if) — commande COMPOSITE. Racine des
 * commandes L3 par-interface (`ip address`, plus tard `ip mtu`,
 * `ip access-group`, …). `ip` seul renvoie « Incomplete command. » —
 * même sémantique que le vrai IOS.
 */
export class CiscoRouterConfigIfIpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ip',
    summary: 'Interface IP configuration',
    usage: 'ip <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoRouterIpAddressCommand());
    this.subRegistry.register(() => new CiscoRouterConfigIfIpAccessGroupCommand());
    this.subRegistry.register(() => new CiscoRouterConfigIfIpHelperAddressCommand());
    this.subRegistry.register(() => new CiscoRouterConfigIfIpNatCommand());
    this.subRegistry.register(() => new CiscoRouterConfigIfIpProxyArpCommand());
    this.subRegistry.register(() => new CiscoRouterConfigIfIpRedirectsCommand());
    this.subRegistry.register(() => new CiscoRouterConfigIfIpUnreachablesCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
