import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `network` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class CiscoRouterConfigRouterNetworkCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'network',
    summary: 'Include a network in the routing protocol',
    usage: 'network <net> <wildcard-or-mask> [area <id>]',
    args: [
      { name: 'net', type: 'string', required: true, description: 'Network prefix' },
      { name: 'mask', type: 'string', required: true, description: 'Wildcard mask or subnet mask' },
      { name: 'areaKw', type: 'string', required: false, description: 'Optional keyword: area' },
      { name: 'areaId', type: 'string', required: false, description: 'Area id (OSPF)' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-router'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const net = ctx.args.get<string>('net');
    const mask = ctx.args.get<string>('mask');
    const areakw = ctx.args.get<string | undefined>('areaKw');
    const areaid = ctx.args.get<string | undefined>('areaId');

    // TODO: lire UNIQUEMENT via la MachineApi ci-dessus, puis formater
    // chaque ligne de sortie inline (jamais de formateur legacy réutilisé).

    return EXIT_OK;
  }
}
