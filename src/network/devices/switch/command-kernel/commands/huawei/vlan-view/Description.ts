import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `description <text...>` (Huawei VRP switch, vlan-view) — feuille
 * standalone. Renomme le VLAN sélectionné (le nom VRP fait office de
 * description). Délègue à `SwitchMachineApi.switch.renameVlan`.
 */
export class HuaweiSwitchVlanDescriptionCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'description',
    summary: 'Set the VLAN description (name)',
    usage: 'description <text>',
    args: [{ name: 'text', type: 'string', required: true, variadic: true, description: 'Description text' }],
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
