import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../../RouterMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `access-group` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class CiscoRouterConfigIfIpAccessGroupCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'access-group',
    summary: 'Apply an ACL to the interface',
    usage: 'ip access-group <name> {in|out}',
    args: [
      { name: 'name', type: 'string', required: true, description: 'ACL name/number' },
      { name: 'dir', type: 'string', required: true, description: 'in | out' },
    ],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const name = ctx.args.get<string>('name');
    const dir = ctx.args.get<string>('dir');

    // TODO: lire UNIQUEMENT via la MachineApi ci-dessus, puis formater
    // chaque ligne de sortie inline (jamais de formateur legacy réutilisé).

    return EXIT_OK;
  }
}
