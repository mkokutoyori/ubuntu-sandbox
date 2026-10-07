import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `flash` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class CiscoSwitchShowFlashCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'flash',
    summary: 'Show flash filesystem',
    usage: 'show flash',
    args: [],
    options: [],
    privileges: ANY,
    category: 'switch',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    // TODO: lire UNIQUEMENT via la MachineApi ci-dessus, puis formater
    // chaque ligne de sortie inline (jamais de formateur legacy réutilisé).
    await ctx.io.stdout.write('TODO\n');
    return EXIT_OK;
  }
}
