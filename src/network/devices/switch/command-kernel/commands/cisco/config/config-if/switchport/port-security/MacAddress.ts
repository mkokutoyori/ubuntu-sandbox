import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoSwitchPortSecurityMacAddressStickyCommand } from './mac-address/Sticky';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `switchport port-security mac-address` (composite) — pour `sticky`,
 *  plus tard `<H.H.H> [vlan <id>]` (statique). */
export class CiscoSwitchPortSecurityMacAddressCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'mac-address',
    summary: 'Secure MAC address configuration',
    usage: 'switchport port-security mac-address sticky',
    args: [], options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchPortSecurityMacAddressStickyCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
