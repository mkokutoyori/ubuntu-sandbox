import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `arp-ping` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class HuaweiRouterUserArpPingCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'arp-ping',
    summary: 'Send ARP probe to a host',
    usage: 'arp-ping ip <A.B.C.D> [interface <iface>]',
    args: [
      { name: 'rest', type: 'string', required: true, variadic: true, description: 'arp-ping tokens' },
    ],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user-view'];

  async execute(_ctx: CommandContext): Promise<ExitCode> {
    // Commande VRP acceptee par le CLI. La semantique complete
    // (mutation MachineApi, application au plan de donnees) sera
    // portee par une vague ulterieure -- silence vendor en attendant.
    return EXIT_OK;
  }
}
