import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

function abbrev(n: string): string {
  return n.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi').replace('TenGigabitEthernet', 'Te');
}

/** `show etherchannel summary` (Cisco Catalyst). */
export class CiscoSwitchEtherchannelSummaryCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'summary', summary: 'EtherChannel one-line summary per group',
    usage: 'show etherchannel summary',
    args: [], options: [], privileges: ANY, category: 'switch',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const groups = new Map<number, string[]>();
    for (const iface of machine.switch.interfaces()) {
      if (iface.lacpGroupId === undefined) continue;
      const arr = groups.get(iface.lacpGroupId) ?? [];
      arr.push(abbrev(iface.name));
      groups.set(iface.lacpGroupId, arr);
    }
    const lines: string[] = [
      `Number of channel-groups in use: ${groups.size}`,
      `Number of aggregators:           ${groups.size}`,
      '',
      'Group  Port-channel  Protocol    Ports',
      '------+-------------+-----------+-----------------------------------------------',
    ];
    for (const [id, ports] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`${String(id).padEnd(7)}Po${String(id).padEnd(12)}LACP        ${ports.join(' ')}`);
    }
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
