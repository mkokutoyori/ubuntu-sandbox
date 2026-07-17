import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `neighbor` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class CiscoRouterConfigRouterNeighborCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'neighbor',
    summary: 'BGP/EIGRP neighbor configuration',
    usage: 'neighbor <A.B.C.D> remote-as <as>',
    args: [
      { name: 'ip', type: 'string', required: true, description: 'Neighbor IP' },
      { name: 'remoteAsKw', type: 'string', required: true, description: 'Keyword: remote-as' },
      { name: 'asNum', type: 'int', required: true, description: 'Remote AS number' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-router'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const ip = ctx.args.get<string>('ip');
    const remoteaskw = ctx.args.get<string>('remoteAsKw');
    const asnum = ctx.args.get<number>('asNum');

    // TODO: lire UNIQUEMENT via la MachineApi ci-dessus, puis formater
    // chaque ligne de sortie inline (jamais de formateur legacy réutilisé).

    return EXIT_OK;
  }
}
