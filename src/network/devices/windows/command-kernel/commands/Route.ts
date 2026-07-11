import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { IPAddress, SubnetMask } from '@/network/core/types';
import type { WindowsNetConfigApi } from '@/command-kernel/machine/types';

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

export class RouteCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'route',
    summary: 'Affiche et modifie la table de routage',
    usage: ROUTE_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options route' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
    // `route` accepte des switches style BSD (`-f`, `-p`, `-4`, `-6`) en plus
    // de ses commandes positionnelles (`print`/`add`/`delete`/`change`) —
    // doivent atterrir en positionnels bruts, comme pour `arp`.
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    let args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.netConfig) {
      await ctx.io.stdout.write('ROUTE: not supported on this device\n');
      return 1;
    }

    if (args.includes('/?') || args.includes('/help')) {
      await ctx.io.stdout.write(ROUTE_HELP + '\n');
      return EXIT_OK;
    }

    while (args.length > 0 && args[0].startsWith('-')) {
      args = args.slice(1);
    }

    let out: string;
    if (args.length === 0 || args[0].toLowerCase() === 'print') {
      out = this.showRoutePrint(ctx.machine.netConfig);
    } else {
      const command = args[0].toLowerCase();
      if (command === 'add' && args.length >= 2) out = this.routeAdd(ctx.machine.netConfig, args.slice(1));
      else if (command === 'delete' && args.length >= 2) out = this.routeDelete(ctx.machine.netConfig, args.slice(1));
      else if (command === 'change' && args.length >= 2) out = this.routeChange(ctx.machine.netConfig, args.slice(1));
      else out = ROUTE_HELP;
    }
    if (out) await ctx.io.stdout.write(out + '\n');
    return EXIT_OK;
  }

  private routeAdd(netConfig: WindowsNetConfigApi, args: string[]): string {
    if (args[0] === 'default' && args[1]) {
      try {
        netConfig.setDefaultGateway(new IPAddress(args[1]).toString());
        return '';
      } catch (e: unknown) {
        return `The route addition failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    const maskIdx = args.findIndex((a) => a.toLowerCase() === 'mask');
    if (maskIdx === -1 || maskIdx + 2 >= args.length) {
      return 'The route addition failed: The parameter is incorrect, invalid syntax.';
    }

    try {
      const destStr = args[maskIdx - 1] || args[0];
      const maskStr = args[maskIdx + 1];
      const gwStr = args[maskIdx + 2];

      const dest = new IPAddress(destStr);
      const mask = new SubnetMask(maskStr);
      const gw = new IPAddress(gwStr);

      let metric = 1;
      const metricIdx = args.findIndex((a) => a.toLowerCase() === 'metric');
      if (metricIdx !== -1 && args[metricIdx + 1]) {
        metric = parseInt(args[metricIdx + 1], 10);
      }

      if (destStr === '0.0.0.0' && maskStr === '0.0.0.0') {
        netConfig.setDefaultGateway(gw.toString());
        return '';
      }

      if (!dest.networkAddress(mask).equals(dest)) {
        return 'The route addition failed: The specified mask parameter is invalid. (Destination & Mask) != Destination.';
      }

      if (!netConfig.addRoute(dest.toString(), mask.toString(), gw.toString(), metric)) {
        return 'The route addition failed: the gateway is not reachable.';
      }
      return '';
    } catch (e: unknown) {
      return `The route addition failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private routeChange(netConfig: WindowsNetConfigApi, args: string[]): string {
    const maskIdx = args.findIndex((a) => a.toLowerCase() === 'mask');
    if (maskIdx === -1 || maskIdx + 2 >= args.length) {
      return 'The route change failed: The parameter is incorrect, invalid syntax.';
    }
    try {
      const dest = new IPAddress(args[maskIdx - 1] || args[0]);
      const mask = new SubnetMask(args[maskIdx + 1]);
      const gw = new IPAddress(args[maskIdx + 2]);
      let metric = 1;
      const metricIdx = args.findIndex((a) => a.toLowerCase() === 'metric');
      if (metricIdx !== -1 && args[metricIdx + 1]) metric = parseInt(args[metricIdx + 1], 10);
      netConfig.removeRoute(dest.toString(), mask.toString());
      netConfig.addRoute(dest.toString(), mask.toString(), gw.toString(), metric);
      return '';
    } catch (e: unknown) {
      return `The route change failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private routeDelete(netConfig: WindowsNetConfigApi, args: string[]): string {
    if (args[0] === 'default' || args[0] === '0.0.0.0') {
      netConfig.clearDefaultGateway();
      return '';
    }

    if (args[0].includes('*')) {
      const prefix = args[0].slice(0, args[0].indexOf('*'));
      let removed = 0;
      for (const r of netConfig.routes()) {
        if (r.network.startsWith(prefix)) {
          if (netConfig.removeRoute(r.network, r.mask)) removed++;
        }
      }
      return removed > 0 ? '' : 'The route deletion failed: Element not found.';
    }

    try {
      const dest = new IPAddress(args[0]);
      let mask = new SubnetMask('255.255.255.0');
      const maskIdx = args.findIndex((a) => a.toLowerCase() === 'mask');
      if (maskIdx !== -1 && args[maskIdx + 1]) {
        mask = new SubnetMask(args[maskIdx + 1]);
      } else {
        const match = netConfig.routes().find((r) => r.network === args[0]);
        if (match) mask = new SubnetMask(match.mask);
      }

      if (!netConfig.removeRoute(dest.toString(), mask.toString())) {
        return 'The route deletion failed: Element not found.';
      }
      return '';
    } catch (e: unknown) {
      return `The route deletion failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private showRoutePrint(netConfig: WindowsNetConfigApi): string {
    const table = netConfig.routes();
    const adapters = netConfig.adapters();
    const lines = [
      '===========================================================================',
      'Interface List',
    ];

    for (const a of adapters) {
      const mac = a.mac.replace(/:/g, ' ');
      const displayNum = a.name.replace('eth', '');
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
      const dest = route.network.padEnd(24);
      const mask = route.mask.padEnd(16);
      const gw = route.nextHop ? route.nextHop.padEnd(15) : 'On-link        ';
      const adapter = adapters.find((a) => a.name === route.iface);
      const iface = (adapter?.ip || route.iface).padEnd(14);
      lines.push(`  ${dest} ${mask} ${gw} ${iface} ${route.metric}`);
    }

    lines.push('===========================================================================');
    lines.push('Persistent Routes:');
    lines.push('  None');
    return lines.join('\n');
  }
}
