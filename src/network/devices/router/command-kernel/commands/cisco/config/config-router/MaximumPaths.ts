import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `maximum-paths` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class CiscoRouterConfigRouterMaximumPathsCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'maximum-paths',
    summary: 'Set maximum ECMP paths',
    usage: 'maximum-paths <n>',
    args: [
      { name: 'n', type: 'int', required: true, description: 'Max paths (1..32)' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-router'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const n = ctx.args.get<number>('n');

    // TODO: lire UNIQUEMENT via la MachineApi ci-dessus, puis formater
    // chaque ligne de sortie inline (jamais de formateur legacy réutilisé).

    return EXIT_OK;
  }
}
