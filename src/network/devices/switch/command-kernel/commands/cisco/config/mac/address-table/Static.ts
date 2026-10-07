import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `static` — TODO: une ligne d'intention métier.
 * Commande feuille standalone : `ctx.machine` est l'unique source de données, formatage inline.
 */
export class CiscoSwitchConfigMacAddressTableStaticCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'static',
    summary: 'Static MAC entry',
    usage: 'mac address-table static <mac> vlan <id> interface <if>',
    args: [
      { name: 'rest', type: 'string', required: true, variadic: true, description: 'mac + vlan + interface tokens' },
    ],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const rest = ctx.args.get<string[]>('rest');

    // TODO: lire UNIQUEMENT via la MachineApi ci-dessus, puis formater
    // chaque ligne de sortie inline (jamais de formateur legacy réutilisé).
    await ctx.io.stdout.write('TODO\n');
    return EXIT_OK;
  }
}
