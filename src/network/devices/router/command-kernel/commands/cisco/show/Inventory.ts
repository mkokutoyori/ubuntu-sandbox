import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `inventory` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class CiscoRouterShowInventoryCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'inventory',
    summary: 'Show hardware inventory',
    usage: 'show inventory',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    // TODO: lire UNIQUEMENT via la MachineApi ci-dessus, puis formater
    // chaque ligne de sortie inline (jamais de formateur legacy réutilisé).
    await ctx.io.stdout.write('TODO\n');
    return EXIT_OK;
  }
}
