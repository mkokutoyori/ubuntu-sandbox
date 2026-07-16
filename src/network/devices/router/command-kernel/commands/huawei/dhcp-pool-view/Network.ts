import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `network` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class HuaweiRouterPoolNetworkCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'network',
    summary: 'Set the DHCP pool network/mask',
    usage: 'network <A.B.C.D> mask <M.M.M.M>',
    args: [
      { name: 'network', type: 'string', required: true, description: 'network address' },
      { name: 'maskKw', type: 'string', required: false, description: 'literal `mask` keyword' },
      { name: 'mask', type: 'string', required: false, description: 'subnet mask' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['dhcp-pool-view'];

  async execute(_ctx: CommandContext): Promise<ExitCode> {
    // Commande VRP acceptee par le CLI. La semantique complete
    // (mutation MachineApi, application au plan de donnees) sera
    // portee par une vague ulterieure -- silence vendor en attendant.
    return EXIT_OK;
  }
}
