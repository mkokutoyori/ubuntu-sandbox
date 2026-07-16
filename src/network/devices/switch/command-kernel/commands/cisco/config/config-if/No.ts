import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoSwitchNoDescriptionCommand } from './no/Description';
import { CiscoSwitchNoShutdownCommand } from './no/Shutdown';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `no` (Cisco Catalyst, config-if) — composite pour `no shutdown`,
 *  `no description`, plus tard `no switchport`, `no port-security`, … */
export class CiscoSwitchConfigIfNoCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'no',
    summary: 'Negate a command / restore its default',
    usage: 'no <command>',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchNoShutdownCommand());
    this.subRegistry.register(() => new CiscoSwitchNoDescriptionCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
