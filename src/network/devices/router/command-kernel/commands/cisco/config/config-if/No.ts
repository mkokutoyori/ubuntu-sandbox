import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoRouterConfigIfNoIpCommand } from './no/Ip';
import { CiscoRouterNoShutdownCommand } from './no/Shutdown';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `no` (Cisco IOS, mode config-if) — commande COMPOSITE. Racine des
 * « négations » à l'interface (`no shutdown`, `no ip address`, plus
 * tard `no description`, `no mtu`). Chaque négation est une feuille
 * dans le sous-registre — pas de dispatch ad-hoc.
 */
export class CiscoRouterConfigIfNoCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'no',
    summary: 'Negate a command / restore its default',
    usage: 'no <command>',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoRouterNoShutdownCommand());
    this.subRegistry.register(() => new CiscoRouterConfigIfNoIpCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
