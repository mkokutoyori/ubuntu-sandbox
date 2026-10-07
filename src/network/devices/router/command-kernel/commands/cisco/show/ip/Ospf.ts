import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `ospf` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class CiscoRouterShowIpOspfCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ospf',
    summary: 'Show OSPF info',
    usage: 'show ip ospf [neighbor|interface|database]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'OSPF sub-view' },
    ],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const rest = ctx.args.get<string[] | undefined>('rest');

    // TODO: lire UNIQUEMENT via la MachineApi ci-dessus, puis formater
    // chaque ligne de sortie inline (jamais de formateur legacy réutilisé).
    await ctx.io.stdout.write('TODO\n');
    return EXIT_OK;
  }
}
