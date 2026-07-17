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

/** `show interfaces status` (Cisco Catalyst). */
export class CiscoSwitchShowInterfacesStatusCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'status', summary: 'Show interfaces status summary',
    usage: 'show interfaces status',
    args: [], options: [], privileges: ANY, category: 'switch',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const lines: string[] = ['Port      Name               Status       Vlan       Duplex  Speed Type'];
    for (const iface of machine.switch.interfaces()) {
      const port = pad(abbrev(iface.name), 10);
      const nm = pad(iface.description.slice(0, 18), 19);
      const status = iface.adminUp ? (iface.linkUp ? 'connected' : 'notconnect') : 'disabled';
      const vlan = iface.mode === 'trunk' ? 'trunk' : String(iface.accessVlan);
      lines.push(`${port}${nm}${pad(status, 13)}${pad(vlan, 11)}${pad('a-full', 8)}${pad('a-100', 6)}10/100BaseTX`);
    }
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
