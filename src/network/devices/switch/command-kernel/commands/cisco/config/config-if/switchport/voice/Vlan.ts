import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../../../SwitchMachineApi';
import { broadcastInterfaces } from '../../selected-interfaces';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** `switchport voice vlan <id>` — feuille. Le vendeur accepte aussi
 *  les mots-clés `dot1p`, `none`, `untagged` mais on ne les gère pas
 *  ici (non requis pour la vague en cours ; extension future ouverte). */
export class CiscoSwitchportVoiceVlanCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vlan',
    summary: 'Voice VLAN for phones',
    usage: 'switchport voice vlan <vlan-id>',
    args: [{ name: 'id', type: 'int', required: true, description: 'Voice VLAN ID (1-4094)' }],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const ifaces = broadcastInterfaces(ctx.session);
    if (ifaces.length === 0) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    const id = ctx.args.get<number>('id');
    if (!Number.isInteger(id) || id < 1 || id > 4094) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    for (const iface of ifaces) {
      if (!machine.switch.setInterfaceVoiceVlan(iface, id)) {
        await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
        return 1;
      }
    }
    return EXIT_OK;
  }
}
