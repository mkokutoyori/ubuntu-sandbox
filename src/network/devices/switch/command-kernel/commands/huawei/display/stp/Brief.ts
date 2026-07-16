import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `brief` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class HuaweiSwitchDisplayStpBriefCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'brief',
    summary: 'Display STP brief information',
    usage: 'display stp brief',
    args: [],
    options: [],
    privileges: ANY,
    category: 'switch',
  };
  readonly allowedModes = ['user-view', 'system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    // Rendu VRP light : une ligne par port de switch. La colonne `Role`
    // sera calculée par le futur STP MachineApi ; pour l'instant on
    // fait un placeholder « - » (fonctionnellement neutre — l'objectif
    // ici est que le `display stp brief` ne soit plus « Unrecognized
    // command »).
    const lines = ['MSTID  Port                        Role  STP State     Protection'];
    for (const info of machine.switch.interfaces()) {
      const state = info.linkUp ? 'FORWARDING' : 'DISCARDING';
      lines.push(`0      ${info.name.padEnd(28)}-     ${state.padEnd(13)} NONE`);
    }
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
