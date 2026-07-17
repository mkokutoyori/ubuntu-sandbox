import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

function pad(v: string, n: number): string { return v.padEnd(n); }
function abbrev(name: string): string {
  return name.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi').replace('TenGigabitEthernet', 'Te');
}
function compactVlanList(vlans: readonly number[]): string {
  if (vlans.length === 0) return 'none';
  if (vlans.length >= 4094) return '1-4094';
  const ranges: string[] = [];
  let s = vlans[0]; let e = s;
  for (let i = 1; i < vlans.length; i++) {
    if (vlans[i] === e + 1) e = vlans[i];
    else { ranges.push(s === e ? String(s) : `${s}-${e}`); s = vlans[i]; e = s; }
  }
  ranges.push(s === e ? String(s) : `${s}-${e}`);
  return ranges.join(',');
}

/** `show interfaces trunk` (Cisco Catalyst). */
export class CiscoSwitchShowInterfacesTrunkCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'trunk', summary: 'Show operational trunks', usage: 'show interfaces trunk',
    args: [], options: [], privileges: ANY, category: 'switch',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const trunks = machine.switch.interfaces().filter((i) => i.mode === 'trunk');
    if (trunks.length === 0) { await ctx.io.stdout.write('\n'); return EXIT_OK; }
    const lines: string[] = ['Port        Mode             Encapsulation  Status        Native vlan'];
    for (const t of trunks) {
      lines.push(`${pad(abbrev(t.name), 12)}${pad('on', 17)}${pad('802.1q', 15)}${pad('trunking', 14)}${t.trunkNativeVlan}`);
    }
    lines.push('', 'Port        Vlans allowed on trunk');
    for (const t of trunks) lines.push(`${pad(abbrev(t.name), 12)}${compactVlanList(t.trunkAllowedVlans)}`);
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
