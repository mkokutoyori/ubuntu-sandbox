import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi, RouterRouteInfo, RouterRouteType } from '../../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** Nom du protocole VRP correspondant au type de route noyau. Pure
 *  transposition table — fonction locale, réutilisable inline. */
function protoName(type: RouterRouteType): string {
  switch (type) {
    case 'connected': return 'Direct';
    case 'rip':       return 'RIP';
    case 'ospf':      return 'OSPF';
    case 'eigrp':     return 'EIGRP';
    case 'bgp':       return 'BGP';
    default:          return 'Static';
  }
}

/** Preference (« administrative distance » côté Cisco) VRP par défaut,
 *  utilisée quand la MachineApi ne renseigne pas `ad`. */
function defaultPreference(type: RouterRouteType): number {
  switch (type) {
    case 'connected': return 0;
    case 'ospf':      return 10;
    case 'rip':       return 100;
    case 'bgp':       return 255;
    default:          return 60;
  }
}

function nextHopFor(route: RouterRouteInfo, connectedIp: (iface: string) => string): string {
  if (route.type === 'connected') return connectedIp(route.iface);
  if (route.nextHop) return route.nextHop;
  return '0.0.0.0';
}

/**
 * `display ip routing-table` (Huawei VRP routeur) — commande FEUILLE
 * standalone. Lit UNIQUEMENT `RouterMachineApi.router.routes()` +
 * `interfaces()` (pour la résolution du next-hop d'une route connectée).
 * Format vendeur exact : bannière « Route Flags », séparateur, en-tête
 * de colonnes fixes.
 */
export class HuaweiRouterDisplayIpRoutingTableCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'routing-table',
    summary: 'Display the routing table',
    usage: 'display ip routing-table',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user-view', 'system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const routes = machine.router.routes();
    const destinations = new Set(routes.map((r) => `${r.network}/${r.cidr}`));

    const connectedIp = (iface: string): string => {
      const info = machine.router.interface(iface);
      return info?.ip ? info.ip : '127.0.0.1';
    };

    const rows: string[] = [];
    for (const r of routes) {
      const dest = `${r.network}/${r.cidr}`.padEnd(19);
      const proto = protoName(r.type).padEnd(8);
      const pref = String(r.ad || defaultPreference(r.type)).padEnd(5);
      const cost = String(r.metric).padEnd(6);
      const flags = (r.type === 'connected' ? 'D' : 'RD').padEnd(6);
      const nh = nextHopFor(r, connectedIp).padEnd(16);
      rows.push(`${dest} ${proto}${pref}${cost}${flags}${nh}${r.iface}`);
    }

    const lines = [
      'Route Flags: R - relay, D - download to fib',
      '------------------------------------------------------------------------------',
      'Routing Tables: Public',
      `         Destinations : ${destinations.size}        Routes : ${routes.length}`,
      '',
      'Destination/Mask    Proto   Pre  Cost  Flags NextHop         Interface',
      ...rows,
    ];
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
