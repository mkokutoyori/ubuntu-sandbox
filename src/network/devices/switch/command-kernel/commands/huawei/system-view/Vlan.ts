import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `vlan <id>` (Huawei VRP, mode system-view — switch) — commande de
 * PUSH de mode : crée le VLAN s'il n'existe pas puis entre en
 * `vlan-view`. Pose `promptFields['selectedVlan']` — le mode `vlan-view`
 * définit `clearOnExit: ['selectedVlan']` donc `quit` la nettoie.
 * Refus avec message VRP exact si l'id est hors bornes (1..4094).
 */
export class HuaweiSwitchVlanCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vlan',
    summary: 'Create VLAN and enter VLAN view',
    usage: 'vlan <id>',
    args: [{ name: 'id', type: 'int', required: true, description: 'VLAN id (1..4094)' }],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['system-view'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    const machine = ctx.machine as SwitchMachineApi;
    const id = ctx.args.get<number>('id');
    if (!Number.isInteger(id) || id < 1 || id > 4094) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return false;
    }
    // Idempotent : crée le VLAN s'il n'existe pas ; sinon, on entre
    // simplement dans sa vue.
    if (!machine.switch.vlan(id)) {
      const result = machine.switch.createVlan(id);
      if (!result.ok) {
        await ctx.io.stderr.write(`Error: ${result.error ?? 'invalid VLAN'}\n`);
        return false;
      }
    }
    (ctx.session as CliSession).promptFields.set('selectedVlan', String(id));
    return true;
  }

  protected targetMode(): string {
    return 'vlan-view';
  }
}
