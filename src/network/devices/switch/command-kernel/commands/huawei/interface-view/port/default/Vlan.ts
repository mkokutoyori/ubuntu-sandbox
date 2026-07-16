import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `port default vlan <id>` (Huawei VRP switch, interface-view) —
 * feuille standalone. Assigne l'access-VLAN du port sélectionné.
 * Comportement standard : le VLAN est auto-créé s'il n'existe pas.
 * Refuse (message vendeur) si le port n'est pas en `access` : le vrai
 * VRP nécessite `port link-type access` avant.
 */
export class HuaweiSwitchPortDefaultVlanCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vlan',
    summary: 'Assign the port default VLAN',
    usage: 'port default vlan <id>',
    args: [{ name: 'id', type: 'int', required: true, description: 'VLAN id (1..4094)' }],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['interface-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const iface = (ctx.session as CliSession).promptFields.get('selectedInterface');
    if (!iface) {
      await ctx.io.stderr.write('Error: No interface selected.\n');
      return 1;
    }
    const id = ctx.args.get<number>('id');
    if (!Number.isInteger(id) || id < 1 || id > 4094) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    const info = machine.switch.interface(iface);
    if (!info) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    if (info.mode !== 'access') {
      await ctx.io.stderr.write("Error: Please first set the port link-type as access.\n");
      return 1;
    }
    if (!machine.switch.setInterfaceAccessVlan(iface, id)) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
