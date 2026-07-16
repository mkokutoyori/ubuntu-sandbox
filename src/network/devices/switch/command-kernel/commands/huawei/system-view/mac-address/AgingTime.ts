import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `aging-time` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class HuaweiSwitchSysMacAddressAgingTimeCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'aging-time',
    summary: 'Set the MAC aging time in seconds',
    usage: 'mac-address aging-time <seconds>',
    args: [
      { name: 'seconds', type: 'int', required: true, description: 'aging time in seconds' },
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
