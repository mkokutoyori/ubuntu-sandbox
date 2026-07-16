import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** Abréviation Cisco des noms d'interfaces (Fa/Gi/…) — locale à la
 *  commande pour rester standalone (aucun helper legacy importé). */
function abbreviateInterface(name: string): string {
  return name
    .replace('FastEthernet', 'Fa')
    .replace('GigabitEthernet', 'Gi')
    .replace('TenGigabitEthernet', 'Te');
}

/**
 * `show vlan brief` (Cisco Catalyst) — commande FEUILLE standalone.
 * Source unique : `SwitchMachineApi.switch.vlans()` +
 * `SwitchMachineApi.switch.interfaces()` (DTOs). Mise en forme vendeur
 * tabulaire IOS (`VLAN`/`Name`/`Status`/`Ports`) reproduite inline.
 */
export class CiscoSwitchShowVlanBriefCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'brief',
    summary: 'VLAN summary information',
    usage: 'show vlan brief',
    args: [],
    options: [],
    privileges: ANY,
    category: 'switch',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const lines = [
      'VLAN Name                             Status    Ports',
      '---- -------------------------------- --------- -------------------------------',
    ];

    // Index des ports d'accès par VLAN — un seul balayage des DTOs
    // d'interfaces, pas d'accès à un objet vendeur.
    const accessByVlan = new Map<number, string[]>();
    for (const iface of machine.switch.interfaces()) {
      if (iface.mode !== 'access') continue;
      const arr = accessByVlan.get(iface.accessVlan) ?? [];
      arr.push(abbreviateInterface(iface.name));
      accessByVlan.set(iface.accessVlan, arr);
    }

    for (const vlan of machine.switch.vlans()) {
      const name = vlan.name.padEnd(33);
      const status = 'active'.padEnd(10);
      const ports = (accessByVlan.get(vlan.id) ?? []).join(', ');
      lines.push(`${String(vlan.id).padEnd(5)}${name}${status}${ports}`);
    }
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
