import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi, RouterRouteType } from '../../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

const CODE_BY_TYPE: Record<RouterRouteType, string> = {
  connected: 'C',
  static: 'S',
  rip: 'R',
  ospf: 'O',
  eigrp: 'D',
  bgp: 'B',
  default: 'S*',
};

const TYPE_ORDER: Record<RouterRouteType, number> = {
  connected: 0,
  ospf: 1,
  eigrp: 2,
  bgp: 3,
  rip: 4,
  static: 5,
  default: 6,
};

function hasMetric(type: RouterRouteType): boolean {
  // Vrai IOS : toutes les routes sauf `connected` affichent `[AD/metric]`
  // (`S    10.0.3.0/24 [1/0] via 10.0.2.2` par exemple). Le legacy ne le
  // faisait que pour les protocoles dynamiques — écart corrigé ici.
  return type !== 'connected';
}

/**
 * `show ip route` (Cisco IOS routeur) — commande FEUILLE standalone.
 * Source unique : `RouterMachineApi.router.routes()` (DTOs). Reproduit
 * inline le format IOS : ligne de codes, gateway of last resort, puis
 * une ligne par route triée par type (connected → OSPF → EIGRP → BGP →
 * RIP → static → default).
 */
export class CiscoRouterShowIpRouteCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'route',
    summary: 'IP routing table',
    usage: 'show ip route',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user', 'privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const table = machine.router.routes();

    const lines: string[] = [
      'Codes: C - connected, S - static, R - RIP, O - OSPF, D - EIGRP, B - BGP, * - candidate default',
      '',
    ];

    const def = table.find((r) => r.type === 'default' || (r.network === '0.0.0.0' && r.cidr === 0));
    if (def && def.nextHop) {
      lines.push(`Gateway of last resort is ${def.nextHop} to network 0.0.0.0`, '');
    } else {
      lines.push('Gateway of last resort is not set', '');
    }

    const sorted = [...table].sort((a, b) => (TYPE_ORDER[a.type] ?? 7) - (TYPE_ORDER[b.type] ?? 7));
    for (const r of sorted) {
      const code = CODE_BY_TYPE[r.type] ?? 'S';
      const via = r.nextHop !== null ? `via ${r.nextHop}` : 'is directly connected';
      const metricStr = hasMetric(r.type) ? ` [${r.ad}/${r.metric}]` : '';
      lines.push(`${code}    ${r.network}/${r.cidr}${metricStr} ${via}, ${r.iface}`);
    }

    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
