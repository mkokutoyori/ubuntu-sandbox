import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `mode` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class HuaweiSwitchSysStpModeCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'mode',
    summary: 'Set STP working mode',
    usage: 'stp mode <stp|rstp|mstp|vbst>',
    args: [
      { name: 'mode', type: 'string', required: true, description: 'STP mode keyword' },
    ],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['system-view'];

  async execute(_ctx: CommandContext): Promise<ExitCode> {
    // Commande VRP acceptée par le CLI — la sémantique complète
    // (persistance disque, application au plan de données) sera portée
    // par des vagues MachineApi ultérieures. Silence vendor en attendant.
    return EXIT_OK;
  }
}
