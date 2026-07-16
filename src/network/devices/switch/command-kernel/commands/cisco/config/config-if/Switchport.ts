import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoSwitchportAccessCommand } from './switchport/Access';
import { CiscoSwitchportModeCommand } from './switchport/Mode';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `switchport` (Cisco Catalyst, config-if) — commande COMPOSITE
 *  racine des configs L2 par-port (`mode`, `access`, plus tard
 *  `trunk`, `port-security`, …). */
export class CiscoSwitchportCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'switchport',
    summary: 'Set switching characteristics',
    usage: 'switchport <subcommand>',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchportModeCommand());
    this.subRegistry.register(() => new CiscoSwitchportAccessCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
