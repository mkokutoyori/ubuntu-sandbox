/**
 * Windows ROUTE command — routing table management.
 *
 * Supported:
 *   route print                                       — display routing table
 *   route add <dest> mask <mask> <gw> [metric <n>]    — add route
 *   route add default <gw>                            — add default route
 *   route delete <dest>                               — remove route
 *   route /?                                          — usage help
 */

import type { WinCommandContext } from './WinCommandExecutor';
import { IPAddress, SubnetMask } from '../../core/types';

const ROUTE_HELP = `
Manipulates network routing tables.

ROUTE [-f] [-p] [-4|-6] command [destination]
                  [MASK netmask]  [gateway] [METRIC metric]  [IF interface]

  -f           Clears the routing tables of all gateway entries.  If this is
               used in conjunction with one of the commands, the tables are
               cleared prior to running the command.

  -p           When used with the ADD command, makes a route persistent across
               boots of the system. By default, routes are not preserved
               when the system is restarted. Ignored for all other commands,
               which always affect the appropriate persistent routes.

  -4           Force using IPv4.

  -6           Force using IPv6.

  command      One of these:
                 PRINT     Prints  a route
                 ADD       Adds    a route
                 DELETE    Deletes a route
                 CHANGE    Modifies an existing route
  destination  Specifies the host.
  MASK         Specifies that the next parameter is the 'netmask' value.
  netmask      Specifies a subnet mask value for this route entry.
               If not specified, it defaults to 255.255.255.255.
  gateway      Specifies gateway.
  interface    the interface number for the specified route.
  METRIC       specifies the metric, ie. the cost for the destination.

All symbolic names used for destination are looked up in the network database
file NETWORKS. The symbolic names for gateway are looked up in the host name
database file HOSTS.

If the command is PRINT or DELETE. Destination or gateway can be a wildcard,
(wildcard is specified as a star '*'), or the gateway argument may be omitted.

Examples:

    > route PRINT
    > route PRINT -4
    > route PRINT 157*          .... Only prints those matching 157*

    > route ADD 157.0.0.0 MASK 255.0.0.0  157.55.80.1 METRIC 3 IF 2
                             destination^      mask^      gateway^     metric^    Interface^
    > route ADD 3ffe::/32 3ffe::1

    > route CHANGE 157.0.0.0 MASK 255.0.0.0  157.55.80.5 METRIC 2 IF 2

    > route DELETE 157.0.0.0
    > route DELETE 3ffe::/32`.trim();

export function cmdRoute(ctx: WinCommandContext, args: string[]): string {
  if (args.length === 0 || args[0].toLowerCase() === 'print') {
    return showRoutePrint(ctx);
  }

  if (args.includes('/?') || args.includes('/help')) {
    return ROUTE_HELP;
  }

  if (args[0].toLowerCase() === 'add' && args.length >= 2) {
    return routeAdd(ctx, args.slice(1));
  }

  if (args[0].toLowerCase() === 'delete' && args.length >= 2) {
    return routeDelete(ctx, args.slice(1));
  }

  if (args[0].toLowerCase() === 'change') {
    return 'The route modification failed: Element not found.';
  }

  return ROUTE_HELP;
}

function routeAdd(ctx: WinCommandContext, args: string[]): string {
  if (args[0] === 'default' && args[1]) {
    try {
      ctx.setDefaultGateway(new IPAddress(args[1]));
      return ' OK!';
    } catch (e: any) {
      return `The route addition failed: ${e.message}`;
    }
  }

  const maskIdx = args.findIndex(a => a.toLowerCase() === 'mask');
  if (maskIdx === -1 || maskIdx + 2 >= args.length) {
    return 'Usage: route add <dest> mask <mask> <gateway> [metric <n>]';
  }

  try {
    const destStr = args[maskIdx - 1] || args[0];
    const maskStr = args[maskIdx + 1];
    const gwStr = args[maskIdx + 2];

    const dest = new IPAddress(destStr);
    const mask = new SubnetMask(maskStr);
    const gw = new IPAddress(gwStr);

    let metric = 1;
    const metricIdx = args.findIndex(a => a.toLowerCase() === 'metric');
    if (metricIdx !== -1 && args[metricIdx + 1]) {
      metric = parseInt(args[metricIdx + 1], 10);
    }

    if (destStr === '0.0.0.0' && maskStr === '0.0.0.0') {
      ctx.setDefaultGateway(gw);
      return ' OK!';
    }

    if (!ctx.addStaticRoute(dest, mask, gw, metric)) {
      return 'The route addition failed: the gateway is not reachable.';
    }
    return ' OK!';
  } catch (e: any) {
    return `The route addition failed: ${e.message}`;
  }
}

function routeDelete(ctx: WinCommandContext, args: string[]): string {
  if (args[0] === 'default' || args[0] === '0.0.0.0') {
    ctx.clearDefaultGateway();
    return ' OK!';
  }

  try {
    const dest = new IPAddress(args[0]);
    let mask = new SubnetMask('255.255.255.0');
    const maskIdx = args.findIndex(a => a.toLowerCase() === 'mask');
    if (maskIdx !== -1 && args[maskIdx + 1]) {
      mask = new SubnetMask(args[maskIdx + 1]);
    }

    if (!ctx.removeRoute(dest, mask)) {
      return 'The route deletion failed: Element not found.';
    }
    return ' OK!';
  } catch (e: any) {
    return `The route deletion failed: ${e.message}`;
  }
}

function showRoutePrint(ctx: WinCommandContext): string {
  const table = ctx.getRoutingTable();
  const lines = [
    '===========================================================================',
    'Interface List',
  ];

  // List interfaces
  for (const [name, port] of ctx.ports) {
    const mac = port.getMAC().toString().replace(/:/g, ' ');
    const displayNum = name.replace('eth', '');
    const desc = `Intel(R) Ethernet Connection #${parseInt(displayNum) + 1}`;
    lines.push(`  ${(parseInt(displayNum) + 1).toString().padStart(2)}...${mac} ......${desc}`);
  }
  lines.push('   1...........................Software Loopback Interface 1');
  lines.push('===========================================================================');
  lines.push('');
  lines.push('IPv4 Route Table');
  lines.push('===========================================================================');
  lines.push('Active Routes:');
  lines.push('Network Destination        Netmask          Gateway         Interface  Metric');

  for (const route of table) {
    const dest = route.network.toString().padEnd(24);
    const mask = route.mask.toString().padEnd(16);
    const gw = route.nextHop ? route.nextHop.toString().padEnd(15) : 'On-link        ';
    const port = ctx.ports.get(route.iface);
    const iface = port?.getIPAddress()?.toString().padEnd(14) || route.iface.padEnd(14);
    lines.push(`  ${dest} ${mask} ${gw} ${iface} ${route.metric}`);
  }

  lines.push('===========================================================================');
  lines.push('Persistent Routes:');
  lines.push('  None');
  return lines.join('\n');
}
