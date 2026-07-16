import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `display mac-address` (Huawei VRP switch) — commande FEUILLE
 * standalone. Source unique : `SwitchMachineApi.switch.macTable()`
 * (DTOs). Rendu vendeur VRP (S5720) : bannière `MAC address table of
 * slot 0`, colonnes fixes, total à la fin. Format identique au legacy
 * pour ne pas casser la parité vendeur.
 */
export class HuaweiSwitchDisplayMacAddressCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'mac-address',
    summary: 'Display MAC address table',
    usage: 'display mac-address',
    args: [],
    options: [],
    privileges: ANY,
    category: 'switch',
  };
  readonly allowedModes = ['user-view', 'system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const entries = machine.switch.macTable();

    const lines = [
      'MAC address table of slot 0:',
      '-------------------------------------------------------------------------------',
      'MAC Address    VLAN/VSI   Learned-From   Type',
      '-------------------------------------------------------------------------------',
    ];

    if (entries.length === 0) {
      lines.push('No entries found.');
    } else {
      const sorted = [...entries].sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac));
      for (const e of sorted) {
        lines.push(`${e.mac.padEnd(15)}${String(e.vlan).padEnd(11)}${e.port.padEnd(15)}${e.type}`);
      }
    }

    lines.push('-------------------------------------------------------------------------------');
    lines.push(`Total items displayed = ${entries.length}`);

    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
