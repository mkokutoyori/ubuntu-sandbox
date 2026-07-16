import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CiscoSwitchShowMacAddressTableCommand } from './mac/AddressTable';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `show mac` (Cisco Catalyst) — commande COMPOSITE. Point d'entrée des
 * vues MAC (`address-table`, plus tard `address-table dynamic|static|
 * count`). `show mac` seul renvoie « Incomplete command. » — signal
 * migration comme partout ailleurs.
 */
export class CiscoSwitchShowMacCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'mac',
    summary: 'MAC address table information',
    usage: 'show mac address-table',
    args: [],
    options: [],
    privileges: ANY,
    category: 'switch',
  };
  readonly allowedModes = ['user', 'privileged'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new CiscoSwitchShowMacAddressTableCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return 1;
  }
}
