import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `no vlan <id>` (Cisco Catalyst, mode config) — supprime le VLAN de
 *  la base. Refuse VLAN 1 (porté par la façade). */
export class CiscoSwitchNoVlanCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vlan',
    summary: 'Remove a VLAN from the database',
    usage: 'no vlan <vlan-id>',
    args: [{ name: 'id', type: 'int', required: true, description: 'VLAN ID (2-4094)' }],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const id = ctx.args.get<number>('id');
    if (!Number.isInteger(id) || id < 1 || id > 4094) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    const result = machine.switch.deleteVlan(id);
    if (!result.ok) {
      await ctx.io.stderr.write(`% ${result.error ?? 'delete failed'}\n`);
      return 1;
    }
    return EXIT_OK;
  }
}
