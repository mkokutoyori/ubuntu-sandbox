/**
 * `route` — legacy net-tools utility to display or manipulate the IP
 * routing table.
 *
 * Supported invocations:
 *   route                                          — show the routing table
 *   route -n                                       — show, numeric
 *   route add default gw <ip>                      — add default gateway
 *   route add -net <net> netmask <m> gw <gw>       — add a static route
 *   route del default                              — delete default gateway
 *
 * Ported from `LinuxPC.cmdRoute` as part of the Phase-3 refactor so every
 * `LinuxMachine` (PC or server) gets the same behavior.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { IPAddress, SubnetMask } from '../../../../core/types';

function showRouteTable(ctx: LinuxCommandContext): string {
  const table = ctx.net.getRoutingTable();
  const lines = [
    'Kernel IP routing table',
    'Destination     Gateway         Genmask         Flags Metric Ref    Use Iface',
  ];
  for (const r of table) {
    const dest = r.network.toString();
    const gw = r.nextHop ? r.nextHop.toString() : '0.0.0.0';
    const mask = r.mask.toString();
    let flags = 'U';
    if (r.nextHop) flags += 'G';
    if (r.type === 'default') flags = 'UG';
    lines.push(
      `${dest.padEnd(16)}${gw.padEnd(16)}${mask.padEnd(16)}${flags.padEnd(6)}${String(r.metric ?? 0).padEnd(7)}0      0 ${r.iface}`,
    );
  }
  return lines.join('\n');
}

export const routeCommand: LinuxCommand = {
  name: 'route',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'route [-n] | route add/del [-net|-host] target [netmask Nm] [gw Gw]',
  help: 'Show / manipulate the IP routing table.',
  options: [
    { flag: '-n', description: 'Show numerical addresses instead of trying to resolve names.', takesArg: false },
  ],

  complete(_ctx: LinuxCommandContext, args: string[]): string[] {
    const partial = args[args.length - 1] ?? '';
    if (args.length <= 1) {
      return ['-n', 'add', 'del'].filter(w => w.startsWith(partial));
    }
    if (args.length === 2 && (args[0] === 'add' || args[0] === 'del')) {
      return ['default', '-net', '-host'].filter(w => w.startsWith(partial));
    }
    return [];
  },

  run(ctx: LinuxCommandContext, args: string[]): string {
    // route (no args) or route -n: show routing table
    if (args.length === 0 || (args.length === 1 && args[0] === '-n')) {
      return showRouteTable(ctx);
    }

    // route add ...
    if (args[0] === 'add') {
      // route add default gw <ip>
      if (args[1] === 'default' && args[2] === 'gw' && args[3]) {
        try {
          ctx.net.setDefaultGateway(new IPAddress(args[3]));
          return '';
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return `SIOCADDRT: ${msg}`;
        }
      }
      // route add -net <network> netmask <mask> gw <gateway>
      if (args[1] === '-net' && args[2]) {
        const network = args[2];
        let mask = '255.255.255.0';
        let gateway = '';
        for (let i = 3; i < args.length; i++) {
          if (args[i] === 'netmask' && args[i + 1]) { mask = args[i + 1]; i++; }
          else if (args[i] === 'gw' && args[i + 1]) { gateway = args[i + 1]; i++; }
        }
        if (!gateway) return 'SIOCADDRT: No such process';
        try {
          ctx.net.addStaticRoute(new IPAddress(network), new SubnetMask(mask), new IPAddress(gateway));
          return '';
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return `SIOCADDRT: ${msg}`;
        }
      }
      return 'Usage: route add [-net|-host] target [netmask Nm] [gw Gw]';
    }

    // route del default
    if (args[0] === 'del') {
      if (args[1] === 'default') {
        ctx.net.clearDefaultGateway();
        return '';
      }
      return 'Usage: route del [-net|-host] target [netmask Nm] [gw Gw]';
    }

    return 'Usage: route [-n] | route add/del ...';
  },
};
