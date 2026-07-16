import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `name <text...>` (Huawei VRP switch, vlan-view) — feuille standalone.
 * Renomme le VLAN sélectionné via `SwitchMachineApi.switch.renameVlan`.
 * C'est la commande VRP canonique pour changer le nom d'un VLAN (le
 * `description` VRP en vlan-view est un champ séparé stockant une
 * description libre — pas encore migré, cible d'une vague ultérieure
 * qui ajoutera `setVlanDescription` à la MachineApi).
 */
export class HuaweiSwitchVlanNameCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'name',
    summary: 'Rename the selected VLAN',
    usage: 'name <text>',
    args: [{ name: 'text', type: 'string', required: true, variadic: true, description: 'VLAN name' }],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['vlan-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const vlanIdStr = (ctx.session as CliSession).promptFields.get('selectedVlan');
    if (!vlanIdStr) {
      await ctx.io.stderr.write('Error: No VLAN selected.\n');
      return 1;
    }
    const parts = ctx.args.get<string[]>('text') ?? [];
    if (parts.length === 0) {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return 1;
    }
    const result = machine.switch.renameVlan(Number.parseInt(vlanIdStr, 10), parts.join(' '));
    if (!result.ok) {
      await ctx.io.stderr.write(`Error: ${result.error ?? 'invalid VLAN'}.\n`);
      return 1;
    }
    return EXIT_OK;
  }
}
