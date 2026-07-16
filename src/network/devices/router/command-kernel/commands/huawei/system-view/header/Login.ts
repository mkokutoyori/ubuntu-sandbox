import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `login` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class HuaweiRouterHeaderLoginCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'login',
    summary: 'Configure the login banner',
    usage: 'header login information <text>',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'remaining tokens (information <text>)' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['system-view'];

  async execute(_ctx: CommandContext): Promise<ExitCode> {
    // Commande VRP acceptée par le CLI — la sémantique complète
    // (persistance disque, application au plan de données) sera portée
    // par des vagues MachineApi ultérieures. Silence vendor en attendant.
    return EXIT_OK;
  }
}
