/**
 * Linux `ip` command handler (iproute2)
 *
 * Implements: ip addr, ip link, ip route, ip neigh, ip help
 * Uses IpNetworkContext to access network state without coupling to EndHost.
 *
 * Error messages and output match real iproute2 behavior.
 */

// ─── Network Context Interface ──────────────────────────────────────

export interface IpInterfaceInfo {
  name: string;
  mac: string;
  ip: string | null;
  mask: string | null;
  cidr: number | null;
  mtu: number;
  isUp: boolean;
  isConnected: boolean;
  isDHCP: boolean;
  counters: { framesIn: number; framesOut: number; bytesIn: number; bytesOut: number };
}

export interface IpRouteEntry {
  network: string;
  cidr: number;
  nextHop: string | null;
  iface: string;
  type: 'connected' | 'static' | 'default';
  metric: number;
  isDHCP: boolean;
  srcIp?: string;
}

export interface IpNeighborEntry {
  ip: string;
  mac: string;
  iface: string;
  state: string;
}

export interface IpNetworkContext {
  getInterfaceNames(): string[];
  getInterfaceInfo(name: string): IpInterfaceInfo | null;
  configureInterface(ifName: string, ip: string, cidr: number): string;
  removeInterfaceIP(ifName: string): string;
  getRoutingTable(): IpRouteEntry[];
  addDefaultRoute(gateway: string): string;
  addStaticRoute(network: string, cidr: number, gateway: string, metric?: number): string;
  deleteDefaultRoute(): string;
  deleteRoute(network: string, cidr: number): string;
  getNeighborTable(): IpNeighborEntry[];
  addNeighbor(ip: string, mac: string, ifName: string): string;
  deleteNeighbor(ip: string, ifName: string): string;
  flushNeighbors(ifName?: string): string;
  setInterfaceUp(ifName: string): string;
  setInterfaceDown(ifName: string): string;
  /** Optional XFRM (IPsec) context for ip xfrm commands */
  xfrm?: IpXfrmContext;
}

// ─── XFRM types (Linux kernel IPsec transform framework) ────────────

export interface XfrmState {
  src: string;
  dst: string;
  proto: 'esp' | 'ah' | 'comp';
  spi: string;         // hex string, e.g. "0xc0ffeee1"
  mode: 'tunnel' | 'transport';
  encAlg?: string;      // e.g. "aes", "3des"
  encKey?: string;
  authAlg?: string;     // e.g. "hmac(sha256)"
  authKey?: string;
  reqid?: number;
  replayWindow?: number;
}

export interface XfrmPolicy {
  src: string;          // e.g. "10.0.0.0/24"
  dst: string;          // e.g. "10.0.1.0/24"
  dir: 'in' | 'out' | 'fwd';
  action: 'allow' | 'block';
  priority?: number;
  tmplSrc?: string;
  tmplDst?: string;
  tmplProto?: 'esp' | 'ah' | 'comp';
  tmplMode?: 'tunnel' | 'transport';
  tmplReqid?: number;
}

export interface IpXfrmContext {
  states: XfrmState[];
  policies: XfrmPolicy[];
}

// ─── Help Text ──────────────────────────────────────────────────────

const IP_HELP = `Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }
       ip [ -force ] -batch filename
where  OBJECT := { address | addrlabel | l2tp | link | maddress |
                   monitor | mroute | mrule | neigh | netns |
                   ntable | route | rule | sr | tap | tcpmetrics |
                   token | tunnel | tuntap | vrf | xfrm }
       OPTIONS := { -V[ersion] | -s[tatistics] | -d[etails] | -r[esolve] |
                    -h[uman-readable] | -iec | -j[son] | -p[retty] |
                    -f[amily] { inet | inet6 | mpls | bridge | link } |
                    -4 | -6 | -M | -B | -0 |
                    -l[oops] { maximum-addr-flush-attempts } | -br[ief] |
                    -o[neline] | -t[imestamp] | -ts[hort] | -b[atch] [filename] |
                    -rc[vbuf] [size] | -n[etns] name | -N[umeric] | -a[ll] |
                    -c[olor][={always|auto|never}] }`;

const IP_ADDR_HELP = `Usage: ip addr {add|change|replace} IFADDR dev STRING [ LIFETIME ]
                                                      [ CONFFLAG-LIST ]
       ip addr del IFADDR dev STRING [mngtmpaddr]
       ip addr {show|save|flush} [ dev STRING ] [ scope SCOPE-ID ]
                            [ to PREFIX ] [ FLAG-LIST ] [ label LABEL ] [up]
       ip addr {showdump|restore}
IFADDR := PREFIX | ADDR peer PREFIX
          [ broadcast ADDR ] [ anycast ADDR ]
          [ label IFLABEL ] [ scope SCOPE-ID ] [ metric METRIC ]
SCOPE-ID := [ host | link | global | NUMBER ]
FLAG-LIST := [ FLAG-LIST ] FLAG
FLAG  := [ permanent | dynamic | secondary | primary |
           [-]tentative | [-]deprecated | [-]dadfailed | temporary |
           CONFFLAG-LIST ]
CONFFLAG-LIST := [ CONFFLAG-LIST ] CONFFLAG
CONFFLAG  := [ home | nodad | mngtmpaddr | noprefixroute | autojoin ]
LIFETIME := [ valid_lft LFT ] [ preferred_lft LFT ]
LFT := forever | SECONDS`;

const IP_ROUTE_HELP = `Usage: ip route { list | flush } SELECTOR
       ip route save SELECTOR
       ip route restore
       ip route showdump
       ip route get [ ROUTE_GET_FLAGS ] ADDRESS
                            [ from ADDRESS iif STRING ]
                            [ oif STRING ] [ tos TOS ]
                            [ mark NUMBER ] [ vrf NAME ]
                            [ uid NUMBER ] [ ipproto PROTOCOL ]
                            [ sport NUMBER ] [ dport NUMBER ]
       ip route { add | del | change | append | replace } ROUTE
SELECTOR := [ root PREFIX ] [ match PREFIX ] [ exact PREFIX ]
            [ table TABLE_ID ] [ vrf NAME ] [ proto RTPROTO ]
            [ type TYPE ] [ scope SCOPE ]
ROUTE := NODE_SPEC [ INFO_SPEC ]
NODE_SPEC := [ TYPE ] PREFIX [ tos TOS ]
             [ table TABLE_ID ] [ proto RTPROTO ]
             [ scope SCOPE ] [ metric METRIC ]
             [ ttl-propagate { enabled | disabled } ]
INFO_SPEC := { NH | nhid ID } OPTIONS FLAGS [ nexthop NH ]...
NH := [ encap ENCAPTYPE ENCAPHDR ] [ via [ FAMILY ] ADDRESS ]
      [ dev STRING ] [ weight NUMBER ] NHFLAGS`;

const IP_LINK_HELP = `Usage: ip link add [link DEV | parentdev NAME] [ name ] NAME
                   [ txqueuelen PACKETS ]
                   [ address LLADDR ]
                   [ broadcast LLADDR ]
                   [ mtu MTU ] [index IDX ]
                   [ numtxqueues QUEUE_COUNT ]
                   [ numrxqueues QUEUE_COUNT ]
                   type TYPE [ ARGS ]

       ip link delete { DEVICE | dev DEVICE | group DEVGROUP } type TYPE [ ARGS ]

       ip link set { DEVICE | dev DEVICE | group DEVGROUP }
                  [ { up | down } ]
                  [ type TYPE ARGS ]
                  [ arp { on | off } ]
                  [ dynamic { on | off } ]
                  [ multicast { on | off } ]
                  [ allmulticast { on | off } ]
                  [ promisc { on | off } ]
                  [ trailers { on | off } ]
                  [ carrier { on | off } ]
                  [ txqueuelen PACKETS ]
                  [ name NEWNAME ]
                  [ address LLADDR ]
                  [ broadcast LLADDR ]
                  [ mtu MTU ]
                  [ netns { PID | NAME } ]
                  [ link-netns NAME | link-netnsid ID ]
                  [ alias NAME ]
                  [ vf NUM [ mac LLADDR ]
                           [ vlan VLANID [ qos VLAN-QOS ] [ proto VLAN-PROTO ] ]
                           [ rate TXRATE ]
                           [ max_tx_rate TXRATE ]
                           [ min_tx_rate TXRATE ]
                           [ spoofchk { on | off} ]
                           [ query_rss { on | off} ]
                           [ state { auto | enable | disable} ]
                           [ trust { on | off} ]
                           [ node_guid EUI64 ]
                           [ port_guid EUI64 ] ]
                  [ master DEVICE ][ vrf NAME ]
                  [ nomaster ]

       ip link show [ DEVICE | group GROUP ] [up] [master DEV] [vrf NAME] [type TYPE]

       ip link xstats type TYPE [ ARGS ]

       ip link afstats [ dev DEVICE ]
       ip link property add dev DEVICE [ altname NAME .. ]
       ip link property del dev DEVICE [ altname NAME .. ]

TYPE := { bareudp | bond | bond_slave | bridge | bridge_slave |
          dummy | erspan | geneve | gre | gretap | ifb |
          ip6erspan | ip6gre | ip6gretap | ip6tnl |
          ipip | ipoib | ipvlan | ipvtap |
          macsec | macvlan | macvtap |
          netdevsim | nlmon | rmnet | sit | team | team_slave |
          vcan | veth | vlan | vrf | vti | vxcan | vxlan | wwan |
          xfrm }`;

// ─── Main Entry Point ───────────────────────────────────────────────

export function executeIpCommand(ctx: IpNetworkContext, args: string[]): string {
  // Parse global options
  let brief = false;
  let stats = false;
  const filteredArgs: string[] = [];

  for (const arg of args) {
    if (arg === '-br' || arg === '-brief') {
      brief = true;
    } else if (arg === '-s' || arg === '-statistics') {
      stats = true;
    } else if (arg === '-h' || arg === '--help') {
      return IP_HELP;
    } else if (!arg.startsWith('-')) {
      filteredArgs.push(arg);
    }
    // Ignore other options silently
  }

  if (filteredArgs.length === 0) return IP_HELP;

  const object = filteredArgs[0];
  const subArgs = filteredArgs.slice(1);

  switch (object) {
    case 'help':
      return IP_HELP;

    case 'addr':
    case 'address':
    case 'a':
      return brief ? ipAddrBrief(ctx, subArgs) : ipAddr(ctx, subArgs);

    case 'link':
    case 'l':
      return ipLink(ctx, subArgs);

    case 'route':
    case 'r':
      return ipRoute(ctx, subArgs);

    case 'neigh':
    case 'neighbor':
    case 'neighbour':
    case 'n':
      return ipNeigh(ctx, subArgs);

    case 'xfrm':
    case 'x':
      return ipXfrm(ctx, subArgs);

    default:
      return `Object "${object}" is unknown, try "ip help".`;
  }
}

// ─── ip addr ────────────────────────────────────────────────────────

function ipAddr(ctx: IpNetworkContext, args: string[]): string {
  if (args.length === 0 || args[0] === 'show' || args[0] === 'list') {
    return ipAddrShow(ctx, args.slice(args[0] === 'show' || args[0] === 'list' ? 1 : 0));
  }
  if (args[0] === 'add') return ipAddrAdd(ctx, args.slice(1));
  if (args[0] === 'del' || args[0] === 'delete') return ipAddrDel(ctx, args.slice(1));
  if (args[0] === 'help') return IP_ADDR_HELP;
  return `Command "${args[0]}" is unknown, try "ip addr help".`;
}

function ipAddrShow(ctx: IpNetworkContext, args: string[]): string {
  // Parse "dev <name>" filter
  let filterDev: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) {
      filterDev = args[i + 1];
      break;
    }
  }

  if (filterDev) {
    const info = ctx.getInterfaceInfo(filterDev);
    if (!info) return `Device "${filterDev}" does not exist.`;
    const names = ctx.getInterfaceNames();
    const idx = names.indexOf(filterDev) + 1;
    return formatAddrInterface(info, idx);
  }

  const names = ctx.getInterfaceNames();
  const lines: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const info = ctx.getInterfaceInfo(names[i]);
    if (!info) continue;
    if (lines.length > 0) lines.push('');
    lines.push(formatAddrInterface(info, i + 1));
  }
  return lines.join('\n');
}

function formatAddrInterface(info: IpInterfaceInfo, idx: number): string {
  const isLoopback = info.name === 'lo';
  const flags: string[] = [];

  if (isLoopback) {
    flags.push('LOOPBACK');
  } else {
    flags.push('BROADCAST');
  }
  if (info.isUp) flags.push('UP');
  if (isLoopback) {
    flags.push('UP');
  } else {
    flags.push('MULTICAST');
  }
  if (info.isUp && info.isConnected) flags.push('LOWER_UP');

  // Deduplicate UP
  const uniqueFlags = [...new Set(flags)];

  const state = info.isUp && info.isConnected ? 'UP' : 'DOWN';
  const qdisc = isLoopback ? 'noqueue' : 'fq_codel';
  const group = 'default';
  const qlen = isLoopback ? '' : ' qlen 1000';

  const lines: string[] = [];
  lines.push(`${idx}: ${info.name}: <${uniqueFlags.join(',')}> mtu ${info.mtu} qdisc ${qdisc} state ${state} group ${group}${qlen}`);
  lines.push(`    link/${isLoopback ? 'loopback' : 'ether'} ${info.mac} brd ${isLoopback ? '00:00:00:00:00:00' : 'ff:ff:ff:ff:ff:ff'}`);

  if (info.ip && info.cidr !== null) {
    const dynFlag = info.isDHCP ? ' dynamic' : '';
    const scope = isLoopback ? 'host' : 'global';
    const brd = computeBroadcast(info.ip, info.cidr);
    const brdStr = brd ? ` brd ${brd}` : '';
    lines.push(`    inet ${info.ip}/${info.cidr}${brdStr}${dynFlag} scope ${scope} ${info.name}`);
  }

  return lines.join('\n');
}

function computeBroadcast(ip: string, cidr: number): string | null {
  if (cidr >= 31) return null;
  const parts = ip.split('.').map(Number);
  const ipInt = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  const hostBits = 32 - cidr;
  const brd = (ipInt | ((1 << hostBits) - 1)) >>> 0;
  return [
    (brd >>> 24) & 0xFF,
    (brd >>> 16) & 0xFF,
    (brd >>> 8) & 0xFF,
    brd & 0xFF,
  ].join('.');
}

function ipAddrBrief(ctx: IpNetworkContext, args: string[]): string {
  const names = ctx.getInterfaceNames();
  const lines: string[] = [];

  for (const name of names) {
    const info = ctx.getInterfaceInfo(name);
    if (!info) continue;
    const state = info.isUp && info.isConnected ? 'UP' : 'DOWN';
    const ipStr = info.ip && info.cidr !== null ? `${info.ip}/${info.cidr}` : '';
    // Left-pad name to 16 chars, state to 14 chars
    const nameCol = info.name.padEnd(16);
    const stateCol = state.padEnd(14);
    lines.push(`${nameCol}${stateCol}${ipStr}`);
  }

  return lines.join('\n');
}

function ipAddrAdd(ctx: IpNetworkContext, args: string[]): string {
  // ip addr add <ip>/<cidr> dev <name>
  let addrStr: string | null = null;
  let devName: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) {
      devName = args[i + 1];
      i++;
    } else if (!addrStr && !args[i].startsWith('-')) {
      addrStr = args[i];
    }
  }

  if (!addrStr) return 'Error: either "local" or "peer" address is required.';
  if (!devName) return 'Not enough information: "dev" argument is required.';

  const slashIdx = addrStr.indexOf('/');
  if (slashIdx === -1) return 'Error: either "local" or "peer" address is required.';

  const ip = addrStr.slice(0, slashIdx);
  const cidr = parseInt(addrStr.slice(slashIdx + 1), 10);
  if (isNaN(cidr) || cidr < 0 || cidr > 32) return 'Error: invalid prefix length.';

  return ctx.configureInterface(devName, ip, cidr);
}

function ipAddrDel(ctx: IpNetworkContext, args: string[]): string {
  // ip addr del <ip>/<cidr> dev <name>
  let devName: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) {
      devName = args[i + 1];
      i++;
    }
  }

  if (!devName) return 'Not enough information: "dev" argument is required.';

  return ctx.removeInterfaceIP(devName);
}

// ─── ip link ────────────────────────────────────────────────────────

function ipLink(ctx: IpNetworkContext, args: string[]): string {
  if (args.length === 0 || args[0] === 'show' || args[0] === 'list') {
    return ipLinkShow(ctx, args.slice(args[0] === 'show' || args[0] === 'list' ? 1 : 0));
  }
  if (args[0] === 'set') return ipLinkSet(ctx, args.slice(1));
  if (args[0] === 'help') return IP_LINK_HELP;
  return `Command "${args[0]}" is unknown, try "ip link help".`;
}

function ipLinkShow(ctx: IpNetworkContext, args: string[]): string {
  let filterDev: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) {
      filterDev = args[i + 1];
      break;
    }
  }

  if (filterDev) {
    const info = ctx.getInterfaceInfo(filterDev);
    if (!info) return `Device "${filterDev}" does not exist.`;
    const names = ctx.getInterfaceNames();
    const idx = names.indexOf(filterDev) + 1;
    return formatLinkInterface(info, idx);
  }

  const names = ctx.getInterfaceNames();
  const lines: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const info = ctx.getInterfaceInfo(names[i]);
    if (!info) continue;
    if (lines.length > 0) lines.push('');
    lines.push(formatLinkInterface(info, i + 1));
  }
  return lines.join('\n');
}

function formatLinkInterface(info: IpInterfaceInfo, idx: number): string {
  const isLoopback = info.name === 'lo';
  const flags: string[] = [];

  if (isLoopback) {
    flags.push('LOOPBACK');
  } else {
    flags.push('BROADCAST');
  }
  if (info.isUp) flags.push('UP');
  if (isLoopback) {
    flags.push('UP');
  } else {
    flags.push('MULTICAST');
  }
  if (info.isUp && info.isConnected) flags.push('LOWER_UP');

  const uniqueFlags = [...new Set(flags)];

  const state = info.isUp && info.isConnected ? 'UP' : 'DOWN';
  const mode = 'DEFAULT';
  const qdisc = isLoopback ? 'noqueue' : 'fq_codel';
  const group = 'default';
  const qlen = isLoopback ? '' : ' qlen 1000';

  const lines: string[] = [];
  lines.push(`${idx}: ${info.name}: <${uniqueFlags.join(',')}> mtu ${info.mtu} qdisc ${qdisc} state ${state} mode ${mode} group ${group}${qlen}`);
  lines.push(`    link/${isLoopback ? 'loopback' : 'ether'} ${info.mac} brd ${isLoopback ? '00:00:00:00:00:00' : 'ff:ff:ff:ff:ff:ff'}`);

  return lines.join('\n');
}

function ipLinkSet(ctx: IpNetworkContext, args: string[]): string {
  if (args.length === 0) return 'Not enough information: arguments are required.';

  // ip link set <dev> { up | down }
  // ip link set dev <dev> { up | down }
  let devName: string | null = null;
  let action: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) {
      devName = args[i + 1];
      i++;
    } else if (args[i] === 'up' || args[i] === 'down') {
      action = args[i];
    } else if (!devName && !args[i].startsWith('-')) {
      devName = args[i];
    }
  }

  if (!devName) return 'Not enough information: arguments are required.';

  if (action === 'up') return ctx.setInterfaceUp(devName);
  if (action === 'down') return ctx.setInterfaceDown(devName);

  return '';
}

// ─── ip route ───────────────────────────────────────────────────────

function ipRoute(ctx: IpNetworkContext, args: string[]): string {
  if (args.length === 0 || args[0] === 'show' || args[0] === 'list') {
    return ipRouteShow(ctx);
  }
  if (args[0] === 'add') return ipRouteAdd(ctx, args.slice(1));
  if (args[0] === 'del' || args[0] === 'delete') return ipRouteDel(ctx, args.slice(1));
  if (args[0] === 'get') return ipRouteGet(ctx, args.slice(1));
  if (args[0] === 'help') return IP_ROUTE_HELP;
  return `Command "${args[0]}" is unknown, try "ip route help".`;
}

function ipRouteShow(ctx: IpNetworkContext): string {
  const table = ctx.getRoutingTable();
  if (table.length === 0) return '';

  // Sort: connected first, then static, then default
  const sorted = [...table].sort((a, b) => {
    const order: Record<string, number> = { connected: 0, static: 1, default: 2 };
    return (order[a.type] ?? 9) - (order[b.type] ?? 9);
  });

  const lines: string[] = [];
  for (const route of sorted) {
    if (route.type === 'default') {
      const proto = route.isDHCP ? 'dhcp' : 'static';
      const metricStr = route.metric > 0 ? ` metric ${route.metric}` : '';
      lines.push(`default via ${route.nextHop} dev ${route.iface} proto ${proto}${metricStr}`);
    } else if (route.type === 'connected') {
      const srcStr = route.srcIp ? ` src ${route.srcIp}` : '';
      lines.push(`${route.network}/${route.cidr} dev ${route.iface} proto kernel scope link${srcStr} metric ${route.metric}`);
    } else {
      // static
      lines.push(`${route.network}/${route.cidr} via ${route.nextHop} dev ${route.iface} proto static metric ${route.metric}`);
    }
  }

  return lines.join('\n');
}

function ipRouteAdd(ctx: IpNetworkContext, args: string[]): string {
  // ip route add default via <gw> [dev <iface>] [metric <n>]
  // ip route add <net>/<cidr> via <gw> [dev <iface>] [metric <n>]

  if (args.length === 0) return 'Error: need a valid prefix or "default".';

  if (args[0] === 'default') {
    const viaIdx = args.indexOf('via');
    if (viaIdx === -1 || !args[viaIdx + 1]) return 'Error: "via" is required for default route.';
    const gateway = args[viaIdx + 1];
    return ctx.addDefaultRoute(gateway);
  }

  // Static route: <net>/<cidr> via <gw>
  const prefix = args[0];
  const slashIdx = prefix.indexOf('/');
  if (slashIdx === -1) return 'Error: invalid prefix (expected <network>/<cidr>).';

  const network = prefix.slice(0, slashIdx);
  const cidr = parseInt(prefix.slice(slashIdx + 1), 10);
  if (isNaN(cidr) || cidr < 0 || cidr > 32) return 'Error: invalid prefix length.';

  const viaIdx = args.indexOf('via');
  if (viaIdx === -1 || !args[viaIdx + 1]) return 'Error: "via" is required.';
  const gateway = args[viaIdx + 1];

  let metric: number | undefined;
  const metricIdx = args.indexOf('metric');
  if (metricIdx !== -1 && args[metricIdx + 1]) {
    metric = parseInt(args[metricIdx + 1], 10);
  }

  return ctx.addStaticRoute(network, cidr, gateway, metric);
}

function ipRouteDel(ctx: IpNetworkContext, args: string[]): string {
  if (args.length === 0) return 'Error: need a valid prefix or "default".';

  if (args[0] === 'default') {
    return ctx.deleteDefaultRoute();
  }

  // Delete static: <net>/<cidr>
  const prefix = args[0];
  const slashIdx = prefix.indexOf('/');
  if (slashIdx === -1) return 'Error: invalid prefix.';

  const network = prefix.slice(0, slashIdx);
  const cidr = parseInt(prefix.slice(slashIdx + 1), 10);
  if (isNaN(cidr)) return 'Error: invalid prefix.';

  return ctx.deleteRoute(network, cidr);
}

function ipRouteGet(ctx: IpNetworkContext, args: string[]): string {
  if (args.length === 0) return 'Error: need a valid destination address.';

  const dest = args[0];
  const table = ctx.getRoutingTable();

  // Find best matching route (simple: default if nothing else matches)
  const defaultRoute = table.find(r => r.type === 'default');
  const connectedRoutes = table.filter(r => r.type === 'connected' || r.type === 'static');

  // Simple matching: check if dest is in a connected/static network
  for (const route of connectedRoutes) {
    if (isInSubnet(dest, route.network, route.cidr)) {
      return `${dest} dev ${route.iface} src ${route.srcIp || route.network}`;
    }
  }

  if (defaultRoute) {
    return `${dest} via ${defaultRoute.nextHop} dev ${defaultRoute.iface}`;
  }

  return `RTNETLINK answers: Network is unreachable`;
}

function isInSubnet(ip: string, network: string, cidr: number): boolean {
  const ipParts = ip.split('.').map(Number);
  const netParts = network.split('.').map(Number);
  const ipInt = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  const netInt = (netParts[0] << 24) | (netParts[1] << 16) | (netParts[2] << 8) | netParts[3];
  const mask = cidr === 0 ? 0 : ((0xFFFFFFFF << (32 - cidr)) >>> 0);
  return (ipInt & mask) === (netInt & mask);
}

// ─── ip neigh ───────────────────────────────────────────────────────

function ipNeigh(ctx: IpNetworkContext, args: string[]): string {
  const sub = args[0] ?? 'show';

  if (sub === 'show' || sub === 'list') {
    return ipNeighShow(ctx, args.slice(1));
  }
  if (sub === 'add' || sub === 'replace') {
    return ipNeighAdd(ctx, args.slice(1));
  }
  if (sub === 'del' || sub === 'delete') {
    return ipNeighDel(ctx, args.slice(1));
  }
  if (sub === 'flush') {
    return ipNeighFlush(ctx, args.slice(1));
  }
  if (sub === 'help') {
    return 'Usage: ip neigh { add | del | flush | show } [ dev DEV ] [ lladdr LLADDR ] [ nud STATE ] ADDRESS';
  }
  // bare call — treat as show
  return ipNeighShow(ctx, args);
}

function ipNeighShow(ctx: IpNetworkContext, _args: string[]): string {
  const neighbors = ctx.getNeighborTable();
  if (neighbors.length === 0) return '';
  return neighbors
    .map(n => `${n.ip} dev ${n.iface} lladdr ${n.mac} ${n.state}`)
    .join('\n');
}

// ip neigh add <IP> lladdr <MAC> dev <DEV> [nud permanent|static]
function ipNeighAdd(ctx: IpNetworkContext, args: string[]): string {
  const ip = args[0];
  if (!ip) return 'Usage: ip neigh add ADDRESS lladdr LLADDR dev DEV';

  let mac: string | null = null;
  let dev: string | null = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === 'lladdr' && args[i + 1]) { mac = args[++i]; }
    else if (args[i] === 'dev' && args[i + 1]) { dev = args[++i]; }
    else if (args[i] === 'nud') { i++; } // accept but ignore (always static)
  }

  if (!mac) return 'RTNETLINK answers: Invalid argument (missing lladdr)';
  if (!dev) return 'RTNETLINK answers: Invalid argument (missing dev)';

  return ctx.addNeighbor(ip, mac, dev);
}

// ip neigh del <IP> dev <DEV>
function ipNeighDel(ctx: IpNetworkContext, args: string[]): string {
  const ip = args[0];
  if (!ip) return 'Usage: ip neigh del ADDRESS dev DEV';

  let dev: string | null = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) { dev = args[++i]; }
  }
  if (!dev) return 'RTNETLINK answers: Invalid argument (missing dev)';

  return ctx.deleteNeighbor(ip, dev);
}

// ip neigh flush [dev DEV]
function ipNeighFlush(ctx: IpNetworkContext, args: string[]): string {
  let dev: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) { dev = args[++i]; }
  }
  return ctx.flushNeighbors(dev);
}

// ─── ip xfrm ────────────────────────────────────────────────────────

const IP_XFRM_HELP = `Usage: ip xfrm XFRM-OBJECT { COMMAND | help }
where  XFRM-OBJECT := state | policy | monitor`;

const IP_XFRM_STATE_HELP = `Usage: ip xfrm state { add | update | allocspi | delete | get | deleteall | list | flush | count } [ID] [XFRM-LIST]
ID := [ src ADDR ] [ dst ADDR ] [ proto XFRM-PROTO ] [ spi SPI ]
XFRM-PROTO := esp | ah | comp
XFRM-LIST := [ XFRM-LIST ] XFRM-INFO
XFRM-INFO := [ mode MODE ] [ reqid REQID ] [ flag FLAG-LIST ]
             [ enc-alg ALGO [ enc-key KEY ] ] [ auth-alg ALGO [ auth-key KEY ] ]
MODE := transport | tunnel`;

const IP_XFRM_POLICY_HELP = `Usage: ip xfrm policy { add | update | delete | deleteall | get | list | flush | count } [ SELECTOR ] [ dir DIR ] [ OPTS ]
SELECTOR := [ src ADDR[/PLEN] ] [ dst ADDR[/PLEN] ]
DIR := in | out | fwd
OPTS := [ action ACTION ] [ priority PRIORITY ]
        [ tmpl src ADDR dst ADDR [ proto PROTO ] [ mode MODE ] [ reqid REQID ] ]
ACTION := allow | block`;

function ipXfrm(ctx: IpNetworkContext, args: string[]): string {
  if (args.length === 0 || args[0] === 'help') return IP_XFRM_HELP;

  const xfrm = ctx.xfrm;
  if (!xfrm) return 'RTNETLINK answers: Operation not supported';

  switch (args[0]) {
    case 'state':
    case 'sta':
      return ipXfrmState(xfrm, args.slice(1));
    case 'policy':
    case 'pol':
      return ipXfrmPolicy(xfrm, args.slice(1));
    case 'monitor':
      return ''; // no-op in simulator
    default:
      return `Object "${args[0]}" is unknown, try "ip xfrm help".`;
  }
}

function ipXfrmState(xfrm: IpXfrmContext, args: string[]): string {
  if (args.length === 0 || args[0] === 'help') return IP_XFRM_STATE_HELP;

  switch (args[0]) {
    case 'add':
    case 'update':
      return xfrmStateAdd(xfrm, args.slice(1));
    case 'list':
    case 'ls':
    case 'show':
      return xfrmStateList(xfrm);
    case 'delete':
    case 'del':
      return xfrmStateDel(xfrm, args.slice(1));
    case 'deleteall':
      xfrm.states.length = 0;
      return '';
    case 'flush':
      xfrm.states.length = 0;
      return '';
    case 'count':
      return `${xfrm.states.length}`;
    default:
      return IP_XFRM_STATE_HELP;
  }
}

function xfrmStateAdd(xfrm: IpXfrmContext, args: string[]): string {
  const state: XfrmState = {
    src: '0.0.0.0', dst: '0.0.0.0', proto: 'esp',
    spi: '0x0', mode: 'tunnel',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case 'src':   state.src = args[++i] || '0.0.0.0'; break;
      case 'dst':   state.dst = args[++i] || '0.0.0.0'; break;
      case 'proto': state.proto = (args[++i] || 'esp') as 'esp' | 'ah' | 'comp'; break;
      case 'spi':   state.spi = args[++i] || '0x0'; break;
      case 'mode':  state.mode = (args[++i] || 'tunnel') as 'tunnel' | 'transport'; break;
      case 'reqid': state.reqid = parseInt(args[++i] || '0', 10); break;
      case 'replay-window': state.replayWindow = parseInt(args[++i] || '0', 10); break;
      case 'enc':
      case 'enc-alg':
        state.encAlg = args[++i] || '';
        if (i + 1 < args.length && !args[i + 1].startsWith('-') && !['src', 'dst', 'proto', 'spi', 'mode', 'reqid', 'auth', 'auth-alg', 'enc', 'enc-alg', 'replay-window'].includes(args[i + 1])) {
          state.encKey = args[++i];
        }
        break;
      case 'auth':
      case 'auth-alg':
        state.authAlg = args[++i] || '';
        if (i + 1 < args.length && !args[i + 1].startsWith('-') && !['src', 'dst', 'proto', 'spi', 'mode', 'reqid', 'auth', 'auth-alg', 'enc', 'enc-alg', 'replay-window'].includes(args[i + 1])) {
          state.authKey = args[++i];
        }
        break;
    }
  }

  // Remove existing state with same src/dst/proto/spi
  const idx = xfrm.states.findIndex(s => s.src === state.src && s.dst === state.dst && s.proto === state.proto && s.spi === state.spi);
  if (idx >= 0) xfrm.states[idx] = state;
  else xfrm.states.push(state);
  return '';
}

function xfrmStateList(xfrm: IpXfrmContext): string {
  if (xfrm.states.length === 0) return '';
  const lines: string[] = [];
  for (const s of xfrm.states) {
    lines.push(`src ${s.src} dst ${s.dst}`);
    lines.push(`\tproto ${s.proto} spi ${s.spi} reqid ${s.reqid ?? 0} mode ${s.mode}`);
    lines.push(`\treplay-window ${s.replayWindow ?? 0}`);
    if (s.authAlg) {
      lines.push(`\tauth ${s.authAlg} ${s.authKey ? s.authKey.slice(0, 8) + '...' : '(key omitted)'}`);
    }
    if (s.encAlg) {
      lines.push(`\tenc ${s.encAlg} ${s.encKey ? s.encKey.slice(0, 8) + '...' : '(key omitted)'}`);
    }
  }
  return lines.join('\n');
}

function xfrmStateDel(xfrm: IpXfrmContext, args: string[]): string {
  let src = '', dst = '', proto = '', spi = '';
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case 'src':   src = args[++i] || ''; break;
      case 'dst':   dst = args[++i] || ''; break;
      case 'proto': proto = args[++i] || ''; break;
      case 'spi':   spi = args[++i] || ''; break;
    }
  }
  const idx = xfrm.states.findIndex(s =>
    (!src || s.src === src) && (!dst || s.dst === dst) &&
    (!proto || s.proto === proto) && (!spi || s.spi === spi));
  if (idx >= 0) {
    xfrm.states.splice(idx, 1);
    return '';
  }
  return 'RTNETLINK answers: No such file or directory';
}

function ipXfrmPolicy(xfrm: IpXfrmContext, args: string[]): string {
  if (args.length === 0 || args[0] === 'help') return IP_XFRM_POLICY_HELP;

  switch (args[0]) {
    case 'add':
    case 'update':
      return xfrmPolicyAdd(xfrm, args.slice(1));
    case 'list':
    case 'ls':
    case 'show':
      return xfrmPolicyList(xfrm);
    case 'delete':
    case 'del':
      return xfrmPolicyDel(xfrm, args.slice(1));
    case 'deleteall':
      xfrm.policies.length = 0;
      return '';
    case 'flush':
      xfrm.policies.length = 0;
      return '';
    case 'count':
      return `${xfrm.policies.length}`;
    default:
      return IP_XFRM_POLICY_HELP;
  }
}

function xfrmPolicyAdd(xfrm: IpXfrmContext, args: string[]): string {
  const policy: XfrmPolicy = {
    src: '0.0.0.0/0', dst: '0.0.0.0/0', dir: 'out', action: 'allow',
  };

  let inTmpl = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'tmpl') {
      inTmpl = true;
      continue;
    }
    if (inTmpl) {
      switch (args[i]) {
        case 'src':   policy.tmplSrc = args[++i] || ''; break;
        case 'dst':   policy.tmplDst = args[++i] || ''; break;
        case 'proto': policy.tmplProto = (args[++i] || 'esp') as 'esp' | 'ah' | 'comp'; break;
        case 'mode':  policy.tmplMode = (args[++i] || 'tunnel') as 'tunnel' | 'transport'; break;
        case 'reqid': policy.tmplReqid = parseInt(args[++i] || '0', 10); break;
        default:
          // If we hit a non-tmpl keyword, leave tmpl mode
          inTmpl = false;
          i--; // re-process this arg
          break;
      }
    } else {
      switch (args[i]) {
        case 'src':      policy.src = args[++i] || '0.0.0.0/0'; break;
        case 'dst':      policy.dst = args[++i] || '0.0.0.0/0'; break;
        case 'dir':      policy.dir = (args[++i] || 'out') as 'in' | 'out' | 'fwd'; break;
        case 'action':   policy.action = (args[++i] || 'allow') as 'allow' | 'block'; break;
        case 'priority': policy.priority = parseInt(args[++i] || '0', 10); break;
      }
    }
  }

  xfrm.policies.push(policy);
  return '';
}

function xfrmPolicyList(xfrm: IpXfrmContext): string {
  if (xfrm.policies.length === 0) return '';
  const lines: string[] = [];
  for (const p of xfrm.policies) {
    lines.push(`src ${p.src} dst ${p.dst}`);
    lines.push(`\tdir ${p.dir} action ${p.action}${p.priority !== undefined ? ` priority ${p.priority}` : ''}`);
    if (p.tmplSrc || p.tmplDst) {
      lines.push(`\ttmpl src ${p.tmplSrc || '0.0.0.0'} dst ${p.tmplDst || '0.0.0.0'}`);
      lines.push(`\t\tproto ${p.tmplProto || 'esp'} mode ${p.tmplMode || 'tunnel'} reqid ${p.tmplReqid ?? 0}`);
    }
  }
  return lines.join('\n');
}

function xfrmPolicyDel(xfrm: IpXfrmContext, args: string[]): string {
  let src = '', dst = '', dir = '';
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case 'src': src = args[++i] || ''; break;
      case 'dst': dst = args[++i] || ''; break;
      case 'dir': dir = args[++i] || ''; break;
    }
  }
  const idx = xfrm.policies.findIndex(p =>
    (!src || p.src === src) && (!dst || p.dst === dst) && (!dir || p.dir === dir));
  if (idx >= 0) {
    xfrm.policies.splice(idx, 1);
    return '';
  }
  return 'RTNETLINK answers: No such file or directory';
}
