import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoSwitchNoVlanCommand } from './no/Vlan';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `no` (Cisco Catalyst, mode config) — racine des négations globales
 *  du switch (`no vlan`, plus tard `no interface X.Y`, `no hostname`,
 *  …). Distinct du `no` de config-if (interface-scope). */
export class CiscoSwitchConfigNoCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'no',
    summary: 'Negate a command / restore its default',
    usage: 'no <command>',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchNoVlanCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
