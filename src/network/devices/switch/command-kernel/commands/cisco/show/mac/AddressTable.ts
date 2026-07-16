import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `show mac address-table` (Cisco Catalyst) — commande FEUILLE standalone.
 * Source unique : `SwitchMachineApi.switch.macTable()` (DTOs). Reproduit
 * inline le format IOS 2960 (en-tête `Mac Address Table` + tableau
 * `Vlan/Mac Address/Type/Ports` + total). Tri par VLAN puis MAC.
 */
export class CiscoSwitchShowMacAddressTableCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'address-table',
    summary: 'Display MAC address table',
    usage: 'show mac address-table',
    args: [],
    options: [],
    privileges: ANY,
    category: 'switch',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const entries = machine.switch.macTable();

    const head = ['Mac Address Table', '-------------------------------------------'];
    if (entries.length === 0) {
      await ctx.io.stdout.write(`${[...head, 'No entries.'].join('\n')}\n`);
      return EXIT_OK;
    }

    const lines = [
      ...head,
      '',
      'Vlan    Mac Address       Type        Ports',
      '----    -----------       --------    -----',
    ];
    const sorted = [...entries].sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac));
    for (const e of sorted) {
      const vlan = String(e.vlan).padEnd(8);
      const mac = e.mac.padEnd(18);
      const type = e.type === 'static' ? 'STATIC  ' : 'DYNAMIC ';
      lines.push(`${vlan}${mac}${type}    ${e.port}`);
    }
    lines.push('');
    lines.push(`Total Mac Addresses for this criterion: ${entries.length}`);

    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
