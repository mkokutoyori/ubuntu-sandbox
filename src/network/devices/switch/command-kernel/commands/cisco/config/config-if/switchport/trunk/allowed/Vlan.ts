import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../../../../SwitchMachineApi';
import { broadcastInterfaces } from '../../../selected-interfaces';
import { parseVlanList } from '../vlan-list';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `switchport trunk allowed vlan {all|none|<list>|add <list>|remove
 * <list>|except <list>}` (Cisco Catalyst, config-if) — commande FEUILLE
 * unique qui accepte toutes les formes vendeur via un pré-analyseur
 * inline. La grammaire réelle Cisco est un mini-DSL — on l'implémente
 * standalone sans dispatch ad-hoc (règle 2).
 */
export class CiscoSwitchTrunkAllowedVlanCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vlan',
    summary: 'Set allowed VLANs when interface is in trunking mode',
    usage: 'switchport trunk allowed vlan {all | none | <list> | add <list> | remove <list> | except <list>}',
    args: [
      { name: 'headOrList', type: 'string', required: true, description: 'all | none | <list> | add | remove | except' },
      { name: 'list', type: 'string', required: false, description: 'VLAN list (when head is add/remove/except)' },
    ],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const ifaces = broadcastInterfaces(ctx.session);
    if (ifaces.length === 0) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }

    const head = (ctx.args.get<string>('headOrList') ?? '').toLowerCase();
    const list = ctx.args.get<string | undefined>('list');

    // Forme `all` : réinitialise à 1-4094.
    if (head === 'all') {
      for (const iface of ifaces) if (!machine.switch.resetInterfaceTrunkAllowedVlans(iface)) return failInvalid(ctx);
      return EXIT_OK;
    }
    // Forme `none` : Set vide.
    if (head === 'none') {
      for (const iface of ifaces) if (!machine.switch.setInterfaceTrunkAllowedVlans(iface, 'set', new Set())) return failInvalid(ctx);
      return EXIT_OK;
    }
    // Formes `add | remove | except <list>`.
    if (head === 'add' || head === 'remove' || head === 'except') {
      if (!list) return failInvalid(ctx);
      const parsed = parseVlanList(list);
      if (!parsed) return failInvalid(ctx);
      for (const iface of ifaces) if (!machine.switch.setInterfaceTrunkAllowedVlans(iface, head, parsed)) return failInvalid(ctx);
      return EXIT_OK;
    }
    // Forme `<list>` : head IS la liste (chemin par défaut).
    const parsed = parseVlanList(head);
    if (!parsed) return failInvalid(ctx);
    for (const iface of ifaces) if (!machine.switch.setInterfaceTrunkAllowedVlans(iface, 'set', parsed)) return failInvalid(ctx);
    return EXIT_OK;
  }
}

async function failInvalid(ctx: CommandContext): Promise<ExitCode> {
  await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
  return 1;
}

