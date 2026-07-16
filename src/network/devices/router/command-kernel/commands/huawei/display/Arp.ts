import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `display arp` (Huawei VRP routeur) — feuille standalone. Source
 * unique : `RouterMachineApi.router.arpEntries()`. Rendu vendeur exact
 * (colonnes `IP ADDRESS | MAC ADDRESS | EXPIRE(M) | TYPE | INTERFACE`,
 * type `D` pour dynamique, `static` pour statique, âge en minutes).
 */
export class HuaweiRouterDisplayArpCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'arp',
    summary: 'Display the ARP table',
    usage: 'display arp',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user-view', 'system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const entries = machine.router.arpEntries();
    const lines = ['IP ADDRESS      MAC ADDRESS     EXPIRE(M)  TYPE      INTERFACE'];
    if (entries.length === 0) {
      lines.push('No ARP entries found.');
    } else {
      for (const e of entries) {
        const ageMin = Math.floor(e.ageSeconds / 60);
        const type = e.type === 'static' ? 'static' : 'D';
        lines.push(
          `${e.ip.padEnd(16)}${e.mac.padEnd(16)}${String(ageMin).padEnd(11)}${type.padEnd(10)}${e.iface}`,
        );
      }
    }
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
