/**
 * `route` — legacy net-tools utility to display or manipulate the IP
 * routing table.
 *
 * Supported invocations:
 *   route                                           — show the routing table (default shown as "default")
 *   route -n                                        — show, numeric (default shown as 0.0.0.0)
 *   route add default gw <ip>                       — add default gateway
 *   route add -net <net> netmask <m> gw <gw>        — add a static network route
 *   route add -net <net>/<cidr> gw <gw>             — same, CIDR notation
 *   route add -net <net> netmask <m> dev <iface>     — on-link (device) route, no gateway
 *   route add -host <ip> gw <gw>                    — add a /32 host route
 *   route add ... metric <n>                        — set the route metric
 *   route del default                                — delete the default gateway
 *   route del -net <net> [netmask <m>] [gw <gw>]     — delete a static network route
 *   route del -host <ip>                             — delete a host route
 *
 * Ported from `LinuxPC.cmdRoute` as part of the Phase-3 refactor so every
 * `LinuxMachine` (PC or server) gets the same behavior.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { IPAddress, SubnetMask } from '../../../../core/types';
import { renderTable, type TableColumn } from '../../../shells/cli/TextTable';

interface KernelRouteRow {
  destination: string; gateway: string; genmask: string; flags: string; metric: string; iface: string;
}

const KERNEL_ROUTE_COLUMNS: ReadonlyArray<TableColumn<KernelRouteRow>> = [
  { header: 'Destination', width: 15, value: (r) => r.destination },
  { header: 'Gateway', width: 15, value: (r) => r.gateway },
  { header: 'Genmask', width: 15, value: (r) => r.genmask },
  { header: 'Flags', width: 5, value: (r) => r.flags },
  { header: 'Metric', width: 6, value: (r) => r.metric },
  { header: 'Ref', width: 6, value: () => '0' },
  { header: 'Use', width: 3, align: 'right', value: () => '0' },
  { header: 'Iface', value: (r) => r.iface },
];

function showRouteTable(ctx: LinuxCommandContext, numeric: boolean): string {
  const rows = ctx.net.getRoutingTable().map((r): KernelRouteRow => {
    const isDefault = r.type === 'default';
    let flags = 'U';
    if (r.nextHop) flags += 'G';
    if (r.mask.toCIDR() === 32 && r.type !== 'default') flags += 'H';
    return {
      destination: isDefault && !numeric ? 'default' : r.network.toString(),
      gateway: r.nextHop ? r.nextHop.toString() : '0.0.0.0',
      genmask: r.mask.toString(),
      flags,
      metric: String(r.metric ?? 0),
      iface: r.iface,
    };
  });
  return ['Kernel IP routing table', ...renderTable(rows, KERNEL_ROUTE_COLUMNS, { gap: 1, rule: false })].join('\n');
}

/** Parse a destination that may carry CIDR notation (`10.0.0.0/16`) or a bare address. */
function parseNetworkArg(raw: string, fallbackMask: string): { network: IPAddress; mask: SubnetMask } | null {
  const slash = raw.indexOf('/');
  try {
    if (slash !== -1) {
      const cidr = Number.parseInt(raw.slice(slash + 1), 10);
      if (!Number.isFinite(cidr) || cidr < 0 || cidr > 32) return null;
      return { network: new IPAddress(raw.slice(0, slash)), mask: SubnetMask.fromCIDR(cidr) };
    }
    return { network: new IPAddress(raw), mask: new SubnetMask(fallbackMask) };
  } catch {
    return null;
  }
}

interface ParsedTarget {
  network: IPAddress;
  mask: SubnetMask;
  gateway: IPAddress | null;
  dev: string | null;
  metric: number | null;
}

/** Shared arg walker for both `-net` and `-host` forms of add/del. */
function parseRouteTarget(args: string[], isHost: boolean): ParsedTarget | null {
  const targetRaw = args[0];
  if (!targetRaw) return null;
  const parsed = parseNetworkArg(targetRaw, isHost ? '255.255.255.255' : '255.255.255.0');
  if (!parsed) return null;

  let mask = isHost ? SubnetMask.fromCIDR(32) : parsed.mask;
  let gateway: IPAddress | null = null;
  let dev: string | null = null;
  let metric: number | null = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === 'netmask' && args[i + 1]) { mask = new SubnetMask(args[i + 1]); i++; }
    else if (args[i] === 'gw' && args[i + 1]) {
      try { gateway = new IPAddress(args[i + 1]); } catch { return null; }
      i++;
    } else if (args[i] === 'dev' && args[i + 1]) { dev = args[i + 1]; i++; }
    else if (args[i] === 'metric' && args[i + 1]) { metric = Number.parseInt(args[i + 1], 10); i++; }
  }

  return { network: parsed.network, mask, gateway, dev, metric };
}

function ipconfigRouteAdd(ctx: LinuxCommandContext, args: string[]): string {
  if (args[0] === 'default' && args[1] === 'gw' && args[2]) {
    try {
      const gateway = new IPAddress(args[2]);
      if (!ctx.net.gatewayReachable(gateway)) return 'SIOCADDRT: Network is unreachable';
      ctx.net.setDefaultGateway(gateway);
      return '';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `SIOCADDRT: ${msg}`;
    }
  }

  const isHost = args[0] === '-host';
  if (args[0] === '-net' || isHost) {
    const target = parseRouteTarget(args.slice(1), isHost);
    if (!target) return 'Usage: route add [-net|-host] target [netmask Nm] [gw Gw] [dev If] [metric M]';

    if (target.gateway) {
      const ok = ctx.net.addStaticRoute(
        target.network, target.mask, target.gateway, target.metric ?? undefined,
      );
      return ok ? '' : 'SIOCADDRT: Network is unreachable';
    }
    if (target.dev) {
      const ok = ctx.net.addDeviceRoute
        ? ctx.net.addDeviceRoute(target.network, target.mask, target.dev, target.metric ?? undefined)
        : false;
      return ok ? '' : 'SIOCADDRT: No such device';
    }
    return 'SIOCADDRT: Network is unreachable';
  }

  return 'Usage: route add [-net|-host] target [netmask Nm] [gw Gw]';
}

function ipconfigRouteDel(ctx: LinuxCommandContext, args: string[]): string {
  if (args[0] === 'default') {
    ctx.net.clearDefaultGateway();
    return '';
  }

  const isHost = args[0] === '-host';
  if (args[0] === '-net' || isHost) {
    const target = parseRouteTarget(args.slice(1), isHost);
    if (!target) return 'Usage: route del [-net|-host] target [netmask Nm] [gw Gw]';

    const filter: { nextHop?: IPAddress | null; metric?: number } = {};
    if (target.gateway) filter.nextHop = target.gateway;
    if (target.dev) filter.nextHop = null;
    if (target.metric !== null) filter.metric = target.metric;

    const ok = ctx.net.removeRoute(target.network, target.mask, filter);
    return ok ? '' : 'SIOCDELRT: No such process';
  }

  return 'Usage: route del [-net|-host] target [netmask Nm] [gw Gw]';
}

export const routeCommand: LinuxCommand = {
  name: 'route',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'route [-n] | route add/del [-net|-host] target [netmask Nm] [gw Gw] [dev If] [metric M]',
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
    if (args.length === 0 || (args.length === 1 && args[0] === '-n')) {
      return showRouteTable(ctx, args[0] === '-n');
    }

    if (args[0] === 'add') return ipconfigRouteAdd(ctx, args.slice(1));
    if (args[0] === 'del') return ipconfigRouteDel(ctx, args.slice(1));

    return 'Usage: route [-n] | route add/del ...';
  },
};
