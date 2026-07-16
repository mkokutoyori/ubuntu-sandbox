import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `display vlan` (Huawei VRP switch) — commande FEUILLE standalone.
 * Source unique : `SwitchMachineApi.switch.vlans()` +
 * `SwitchMachineApi.switch.interfaces()` (DTOs). Rendu VRP exact :
 * en-tête `VLAN ID | Name | Status | Ports` + une ligne par VLAN, ports
 * d'accès listés par balayage des DTOs d'interfaces.
 */
export class HuaweiSwitchDisplayVlanCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vlan',
    summary: 'Display VLAN information',
    usage: 'display vlan',
    args: [],
    options: [],
    privileges: ANY,
    category: 'switch',
  };
  readonly allowedModes = ['user-view', 'system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const lines = [
      'VLAN ID  Name                          Status   Ports',
      '-------  ----------------------------  -------  ----------------------------',
    ];

    const accessByVlan = new Map<number, string[]>();
    for (const iface of machine.switch.interfaces()) {
      if (iface.mode !== 'access') continue;
      const arr = accessByVlan.get(iface.accessVlan) ?? [];
      arr.push(iface.name);
      accessByVlan.set(iface.accessVlan, arr);
    }

    for (const vlan of machine.switch.vlans()) {
      const id = String(vlan.id).padEnd(9);
      const name = vlan.name.padEnd(30);
      const ports = (accessByVlan.get(vlan.id) ?? []).join(', ');
      lines.push(`${id}${name}active   ${ports}`);
    }
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
