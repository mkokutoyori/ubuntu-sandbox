import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { pushMode } from '@/command-kernel/cli';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';
import { parseVlanList } from './config-if/switchport/trunk/vlan-list';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `vlan <spec>` (Cisco Catalyst, mode config) — commande dual-mode.
 *
 * - Argument = ID unique (`vlan 10`) → crée le VLAN + push config-vlan
 *   (pattern « create-or-select »).
 * - Argument = plage ou liste (`vlan 30-35`, `vlan 10,20,30`) → crée
 *   tous les VLANs et RESTE en config (comportement Cisco : la
 *   sélection unique n'a pas de sens quand on cible plusieurs
 *   entrées à la fois).
 *
 * Le parseur PUR `parseVlanList` (déjà utilisé par `switchport trunk
 * allowed vlan`) sert de source unique — règle 2 : commande standalone
 * mais helper pur autorisé.
 */
export class CiscoSwitchVlanCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vlan',
    summary: 'VLAN commands / configure a VLAN',
    usage: 'vlan <vlan-id> | vlan <range> | vlan <list>',
    args: [{ name: 'spec', type: 'string', required: true, description: 'VLAN ID (1-4094), range (10-15), or list (10,20,30)' }],
    options: [],
    privileges: OP,
    category: 'cli-mode',
  };
  readonly allowedModes = ['config'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const spec = ctx.args.get<string>('spec');

    // Chemin single ID : préserve le comportement historique (push).
    if (spec && /^\d+$/.test(spec)) {
      const id = Number.parseInt(spec, 10);
      if (id < 1 || id > 4094) return failInvalid(ctx);
      const result = machine.switch.createVlan(id);
      if (!result.ok) return failInvalid(ctx);
      (ctx.session as CliSession).promptFields.set('selectedVlan', String(id));
      pushMode(ctx.session as CliSession, 'config-vlan');
      return EXIT_OK;
    }

    // Chemin plage/liste : crée tous, ne push pas.
    const parsed = spec ? parseVlanList(spec) : null;
    if (!parsed || parsed.size === 0) return failInvalid(ctx);
    for (const id of parsed) {
      const result = machine.switch.createVlan(id);
      if (!result.ok) return failInvalid(ctx);
    }
    return EXIT_OK;
  }
}

async function failInvalid(ctx: CommandContext): Promise<ExitCode> {
  await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
  return 1;
}
