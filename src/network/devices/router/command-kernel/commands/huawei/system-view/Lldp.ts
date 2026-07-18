import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `lldp` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class HuaweiRouterSysLldpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'lldp',
    summary: 'LLDP global configuration',
    usage: 'lldp enable [tx-interval <n>]',
    args: [
      { name: 'rest', type: 'string', required: true, variadic: true, description: 'lldp tokens' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['system-view'];

  async execute(_ctx: CommandContext): Promise<ExitCode> {
    // Commande VRP acceptee par le CLI. La semantique complete
    // (mutation MachineApi, application au plan de donnees) sera
    // portee par une vague ulterieure -- silence vendor en attendant.
    return EXIT_OK;
  }
}
