import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** Rendu vendeur : GE0/0/N interne → GigabitEthernet0/0/N. */
function renderInterfaceName(name: string): string {
  return name.startsWith('GE') ? name.replace(/^GE/, 'GigabitEthernet') : name;
}

/**
 * `display current-configuration` (Huawei VRP routeur) — commande
 * FEUILLE standalone. Synthétise une **running-config LIGHT** à partir
 * uniquement de la MachineApi : sysname, interfaces (description /
 * ip address / shutdown), ip route-static. Les autres sous-systèmes
 * (DHCP, ARP static, OSPF, BGP, IPSec, SNMP, NTP, radius, ACL, NAT,
 * SSH server) restent absents — signal explicite pour les vagues de
 * migration futures. Format inspiré du VRP réel (sections séparées
 * par `#`).
 */
export class HuaweiRouterDisplayCurrentConfigurationCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'current-configuration',
    summary: 'Display the current running configuration',
    usage: 'display current-configuration',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user-view', 'system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const lines: string[] = ['#', `sysname ${machine.hostname}`, '#'];

    // Interfaces — bloc par port, `#` en séparateur.
    for (const info of machine.router.interfaces()) {
      lines.push(`interface ${renderInterfaceName(info.name)}`);
      if (info.description) lines.push(` description ${info.description}`);
      if (info.ip && info.mask) {
        lines.push(` ip address ${info.ip} ${info.mask}`);
      }
      if (!info.adminUp) lines.push(` shutdown`);
      lines.push('#');
    }

    // Routes statiques (uniquement, les connectées sont dérivées).
    for (const r of machine.router.routes()) {
      if (r.type !== 'static' && r.type !== 'default') continue;
      lines.push(`ip route-static ${r.network} ${r.mask} ${r.nextHop ?? '0.0.0.0'}`);
    }
    // `return` marque la fin de la running-config côté VRP.
    lines.push('return');

    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
