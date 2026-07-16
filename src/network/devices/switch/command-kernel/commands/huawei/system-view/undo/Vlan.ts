import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `undo vlan <id>` (Huawei VRP switch, system-view) — feuille standalone.
 * Supprime le VLAN via `SwitchMachineApi.switch.deleteVlan`. Interdit sur
 * VLAN 1 (message vendeur `Error: The default VLAN cannot be deleted.`).
 */
export class HuaweiSwitchUndoVlanCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vlan',
    summary: 'Delete a VLAN',
    usage: 'undo vlan <id>',
    args: [{ name: 'id', type: 'int', required: true, description: 'VLAN id to delete' }],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const id = ctx.args.get<number>('id');
    if (id === 1) {
      await ctx.io.stderr.write("Error: The default VLAN cannot be deleted.\n");
      return 1;
    }
    const result = machine.switch.deleteVlan(id);
    if (!result.ok) {
      await ctx.io.stderr.write(`Error: ${result.error ?? 'VLAN not found'}.\n`);
      return 1;
    }
    return EXIT_OK;
  }
}
