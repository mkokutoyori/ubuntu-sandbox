import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoRouterConfigNoIpCommand } from './no/Ip';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `no` (Cisco IOS, mode config) — commande COMPOSITE. Racine des
 * négations en config (`no ip route`, plus tard `no ip access-list`,
 * `no hostname`, `no interface X.Y`, `no router ospf`, …).
 */
export class CiscoRouterConfigNoCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'no',
    summary: 'Negate a command / restore its default',
    usage: 'no <command>',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoRouterConfigNoIpCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
