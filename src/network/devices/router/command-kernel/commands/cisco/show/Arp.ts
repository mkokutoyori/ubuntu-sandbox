import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

function pad(v: string, n: number): string { return v.padEnd(n); }

/** `show arp` (Cisco IOS routeur) — feuille standalone. */
export class CiscoRouterShowArpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'arp', summary: 'Display the ARP table', usage: 'show arp',
    args: [], options: [], privileges: ANY, category: 'router',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const entries = machine.router.arpEntries();
    const lines: string[] = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
    for (const e of entries) {
      const ageStr = e.type === 'static' ? '-' : String(Math.floor(e.ageSeconds / 60));
      lines.push(`Internet  ${pad(e.ip, 17)}${pad(ageStr, 11)}${pad(e.mac, 16)}ARPA   ${e.iface}`);
    }
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
