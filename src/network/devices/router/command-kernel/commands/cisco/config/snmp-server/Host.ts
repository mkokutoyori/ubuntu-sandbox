import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `host` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class CiscoRouterConfigSnmpServerHostCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'host',
    summary: 'SNMP trap destination host',
    usage: 'snmp-server host <ip> <community>',
    args: [
      { name: 'ip', type: 'string', required: true, description: 'Trap host IP' },
      { name: 'community', type: 'string', required: true, description: 'Community name' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const ip = ctx.args.get<string>('ip');
    const community = ctx.args.get<string>('community');

    // TODO: lire UNIQUEMENT via la MachineApi ci-dessus, puis formater
    // chaque ligne de sortie inline (jamais de formateur legacy réutilisé).

    return EXIT_OK;
  }
}
