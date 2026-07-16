import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `vlan <id>` (Cisco Catalyst, mode config) — push de mode config-vlan
 * avec pré-sélection. Crée le VLAN à la volée s'il n'existe pas
 * (comportement Cisco : la commande est un « create-or-select »).
 * L'ID sélectionné est stocké dans `session.promptFields
 * ['selectedVlan']` — nettoyé par `clearOnExit` du mode config-vlan.
 */
export class CiscoSwitchVlanCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vlan',
    summary: 'VLAN commands / configure a VLAN',
    usage: 'vlan <vlan-id>',
    args: [{ name: 'id', type: 'int', required: true, description: 'ISL VLAN IDs 1-4094' }],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['config'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    const machine = ctx.machine as SwitchMachineApi;
    const id = ctx.args.get<number>('id');
    if (!Number.isInteger(id) || id < 1 || id > 4094) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return false;
    }
    const result = machine.switch.createVlan(id);
    if (!result.ok) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return false;
    }
    (ctx.session as CliSession).promptFields.set('selectedVlan', String(id));
    return true;
  }

  protected targetMode(): string {
    return 'config-vlan';
  }
}
