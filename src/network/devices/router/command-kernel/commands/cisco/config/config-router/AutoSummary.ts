import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `auto-summary` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class CiscoRouterConfigRouterAutoSummaryCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'auto-summary',
    summary: 'Enable classful auto-summary',
    usage: 'auto-summary',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-router'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    // TODO: lire UNIQUEMENT via la MachineApi ci-dessus, puis formater
    // chaque ligne de sortie inline (jamais de formateur legacy réutilisé).

    return EXIT_OK;
  }
}
