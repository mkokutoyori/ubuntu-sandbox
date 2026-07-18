import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiSwitchSysMacAddressAgingTimeCommand } from './mac-address/AgingTime';
import { HuaweiSwitchSysMacAddressStaticCommand } from './mac-address/Static';
import { HuaweiSwitchSysMacAddressBlackholeCommand } from './mac-address/Blackhole';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `mac-address` (Huawei VRP switch, system-view) — commande COMPOSITE.
 * Racine des commandes de la MAC address table côté control-plane
 * (`mac-address aging-time`, plus tard `mac-address static`,
 * `mac-address blackhole`, `mac-address flapping`, …).
 */
export class HuaweiSwitchSysMacAddressCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'mac-address',
    summary: 'MAC address table configuration',
    usage: 'mac-address <subcommand>',
    args: [],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['system-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiSwitchSysMacAddressAgingTimeCommand());
    this.subRegistry.register(() => new HuaweiSwitchSysMacAddressStaticCommand());
    this.subRegistry.register(() => new HuaweiSwitchSysMacAddressBlackholeCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
