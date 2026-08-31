/**
 * Linux `ip` command handler (iproute2)
 *
 * Implements: ip addr, ip link, ip route, ip neigh, ip help
 * Uses IpNetworkContext to access network state without coupling to EndHost.
 *
 * Error messages and output match real iproute2 behavior.
 */

import { findHostByAddress } from './network/HostLookup';
import {
  ipColorizer, parseIpColorOption, ipUnknownOptionError,
  type IpColorizer, type IpColorMode,
} from './LinuxIpColor';
import { IPAddress, MACAddress, SubnetMask } from '../../core/types';
import { broadcastAddress } from '../../core/ip';
import {
  buildAddrJsonEntry,
  buildLinkJsonEntry,
  buildRouteJsonEntry,
  buildNeighJsonEntry,
  toJsonText,
} from './commands/net/IpJsonFormat';

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
  txQueueLen?: number;
  promiscuous?: boolean;
  master?: string | null;
  counters: {
    framesIn: number;
    framesOut: number;
    bytesIn: number;
    bytesOut: number;
    errorsIn?: number;
    errorsOut?: number;
  };
  ipv6?: IpInterfaceV6Address[];
  secondaryIPs?: Array<{ ip: string; cidr: number }>;
  /**
   * Interface sans notion de porteuse (`lo`, `dummy`). Linux la
   * distingue partout : son état opérationnel est `UNKNOWN` — ni `UP`
   * ni `DOWN`, parce que la question ne se pose pas — et ses fanions
   * portent `NOARP` au lieu de `MULTICAST`.
   */
  carrierless?: boolean;
}

export interface IpInterfaceV6Address {
  address: string;
  prefixLength: number;
  scope: 'host' | 'link' | 'global';
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
  /** The route's interface has no carrier; `ip route` renders `linkdown`. */
  linkdown?: boolean;
}

export interface IpNeighborEntry {
  ip: string;
  mac: string;
  iface: string;
  state: string;
}

export interface IpV6RouteEntry {
  prefix: string;
  prefixLength: number;
  nextHop: string | null;
  iface: string;
  type: 'connected' | 'static' | 'default' | 'ra';
  metric: number;
}

export interface IpTunnelInfo {
  name: string;
  mode: 'gre';
  local: string;
  remote: string;
  key?: number;
  ttl?: number;
}

export interface IpTunnelContext {
  addTunnel(name: string, local: string, remote: string, opts?: { key?: number; ttl?: number }): string;
  removeTunnel(name: string): string;
  listTunnels(): IpTunnelInfo[];
}

export interface IpLinkOpsContext {
  addDummy(name: string): string;
  addBond(name: string): string;
  enslave(bond: string, iface: string): string;
  release(iface: string): string;
  bondOption(bond: string, key: string, value: string): boolean;
  addVeth(name: string, peerName: string): string;
  addVlan(name: string, parent: string, vid: number): string;
  deleteLink(name: string): string;
}

export interface IpNetworkContext {
  /**
   * The machine these commands run on, so a neighbour lookup follows the
   * cable plant from here (docs/PRD-Frame-Only-Refactor.md P6).
   */
  getLocalDevice?(): object | null;
  getInterfaceNames(): string[];
  getInterfaceInfo(name: string): IpInterfaceInfo | null;
  /** Stable ifindex for an interface, assigned once, never recomputed from list position. */
  getIfIndex(name: string): number;
  configureInterface(ifName: string, ip: IPAddress, cidr: number): string;
  addInterfaceIP?(ifName: string, ip: IPAddress, cidr: number): string;
  addInterfaceIPv6?(ifName: string, addr: string, prefixLength: number): string;
  removeInterfaceIPv6?(ifName: string, addr: string): string;
  removeInterfaceAddress?(ifName: string, ip: IPAddress): string;
  removeInterfaceIP(ifName: string): string;
  getRoutingTable(tableId?: number): IpRouteEntry[];
  getIPv6RoutingTable?(): IpV6RouteEntry[];
  addDefaultRoute(gateway: IPAddress): string;
  addStaticRoute(
    network: IPAddress,
    cidr: number,
    gateway: IPAddress,
    metric?: number,
    routeOpts?: { allowDuplicate?: boolean; table?: number },
  ): string;
  addDeviceRoute?(network: IPAddress, cidr: number, iface: string, table?: number): string;
  deleteDefaultRoute(): string;
  deleteRoute(
    network: IPAddress,
    cidr: number,
    filter?: { nextHop?: IPAddress | null; metric?: number; table?: number },
  ): string;
  getNeighborTable(): IpNeighborEntry[];
  addNeighbor(ip: IPAddress, mac: MACAddress, ifName: string): string;
  deleteNeighbor(ip: IPAddress, ifName: string): string;
  flushNeighbors(ifName?: string): string;
  setInterfaceUp(ifName: string): string;
  setInterfaceDown(ifName: string): string;
  setInterfaceMTU(ifName: string, mtu: number): string;
  setInterfaceMac(ifName: string, mac: string): string;
  setInterfaceTxQueueLen(ifName: string, n: number): string;
  setInterfacePromiscuous(ifName: string, on: boolean): string;
  /** Optional XFRM (IPsec) context for ip xfrm commands */
  xfrm?: IpXfrmContext;
  /** Optional GRE tunnel context for ip tunnel commands */
  tunnel?: IpTunnelContext;
  /** Optional virtual interface CRUD for ip link add/delete */
  linkOps?: IpLinkOpsContext;
  /** Optional policy-routing rule context for ip rule */
  rule?: IpRuleContext;
  /** Optional rule-aware route resolution, for `ip route get from SRC DST` */
  resolveRouteWithRules?(
    dest: IPAddress, from: IPAddress | null,
  ): { iface: string; nextHopIP: string; table: number } | null;
  /** Optional network namespace CRUD for ip netns (list/add/del only — exec is handled upstream) */
  netns?: IpNetnsContext;
  /** Optional IPv4 multicast membership context for `ip maddr` (IGMP). */
  maddr?: IpMaddrContext;
}

export interface IpMaddrContext {
  join(ifName: string, group: string): boolean;
  leave(ifName: string, group: string): boolean;
  list(ifName?: string): Array<{ iface: string; group: string }>;
}

export interface IpNetnsContext {
  add(name: string): string;
  remove(name: string): string;
  list(): string[];
}

export interface IpRuleInfo {
  priority: number;
  from?: string;
  to?: string;
  table: number;
}

export interface IpRuleContext {
  addRule(rule: { priority: number; from?: string; to?: string; table: number }): string;
  removeRule(priority: number): string;
  listRules(): IpRuleInfo[];
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

export type IpFamily = 'any' | 'inet' | 'inet6';

export interface IpOutputOptions {
  family: IpFamily;
  stats: boolean;
  json: boolean;
  pretty: boolean;
  oneline: boolean;
  /** Ce qui colorie la sortie, ou l'identité quand `-c` est absent. */
  color: IpColorizer;
}

/**
 * `outputPiped` répond au seul `-c=auto` : le vrai `ip` n'y colorie que
 * si sa sortie standard est un terminal. Les trois autres formes (`-c`
 * nu, `=always`, `=never`) tranchent sans rien demander à personne.
 */
export function executeIpCommand(
  ctx: IpNetworkContext,
  args: string[],
  outputPiped = false,
): string {
  // Parse global options
  let brief = false;
  let stats = false;
  let json = false;
  let pretty = false;
  let oneline = false;
  let colorMode: IpColorMode = 'never';
  let family: IpFamily = 'any';
  const filteredArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const couleur = parseIpColorOption(arg);
    if (couleur === 'invalid') return ipUnknownOptionError(arg);
    if (couleur !== null) {
      colorMode = couleur;
      continue;
    }
    if (arg === '-br' || arg === '-brief') {
      brief = true;
    } else if (arg === '-s' || arg === '-statistics') {
      stats = true;
    } else if (arg === '-j' || arg === '-json') {
      json = true;
    } else if (arg === '-p' || arg === '-pretty') {
      pretty = true;
    } else if (arg === '-o' || arg === '-oneline') {
      oneline = true;
    } else if (arg === '-4') {
      family = 'inet';
    } else if (arg === '-6') {
      family = 'inet6';
    } else if (arg === '-f' || arg === '-family') {
      const fam = args[++i];
      if (fam === 'inet') family = 'inet';
      else if (fam === 'inet6') family = 'inet6';
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
  const color = ipColorizer(colorMode === 'always' || (colorMode === 'auto' && !outputPiped));
  const outputOpts: IpOutputOptions = { family, stats, json, pretty, oneline, color };

  switch (object) {
    case 'help':
      return IP_HELP;

    case 'addr':
    case 'address':
    case 'a':
      return brief ? ipAddrBrief(ctx, subArgs, color) : ipAddr(ctx, subArgs, outputOpts);

    case 'link':
    case 'l':
      return brief ? ipLinkBrief(ctx, subArgs, color) : ipLink(ctx, subArgs, outputOpts);

    case 'route':
    case 'r':
      return family === 'inet6' ? ipRoute6(ctx, subArgs, outputOpts) : ipRoute(ctx, subArgs, outputOpts);

    case 'neigh':
    case 'neighbor':
    case 'neighbour':
    case 'n':
      return ipNeigh(ctx, subArgs, outputOpts);

    case 'xfrm':
    case 'x':
      return ipXfrm(ctx, subArgs);

    case 'tunnel':
    case 'tunl':
      return ipTunnel(ctx, subArgs);

    case 'rule':
      return ipRule(ctx, subArgs);

    case 'netns':
      return ipNetns(ctx, subArgs);

    case 'maddr':
    case 'maddress':
    case 'm':
      return ipMaddr(ctx, subArgs);

    case 'monitor':
      return '';

    default:
      return `Object "${object}" is unknown, try "ip help".`;
  }
}

// ─── ip maddr ───────────────────────────────────────────────────────

/**
 * `ip maddr {add|del|show} [ADDRESS] [dev NAME]` — multicast group
 * membership. iproute2 accepts an IPv4 group here and the kernel joins it,
 * which is what makes an IGMP Membership Report go out.
 */
function ipMaddr(ctx: IpNetworkContext, args: string[]): string {
  const m = ctx.maddr;
  if (!m) return 'RTNETLINK answers: Operation not supported';

  const cmd = args[0] === undefined || args[0] === 'show' || args[0] === 'list' || args[0] === 'sh'
    ? 'show'
    : args[0];
  const rest = cmd === 'show' && args[0] !== undefined ? args.slice(1) : args.slice(1);

  const devIdx = rest.findIndex(a => a === 'dev');
  const dev = devIdx >= 0 ? rest[devIdx + 1] : undefined;
  const positional = devIdx >= 0
    ? rest.filter((_, i) => i !== devIdx && i !== devIdx + 1)
    : rest;

  if (cmd === 'show') {
    const byIface = new Map<string, string[]>();
    for (const entry of m.list(dev)) {
      const list = byIface.get(entry.iface) ?? [];
      list.push(entry.group);
      byIface.set(entry.iface, list);
    }
    const names = dev ? [dev] : ctx.getInterfaceNames();
    const lines: string[] = [];
    for (const name of names) {
      if (!ctx.getInterfaceInfo(name)) continue;
      lines.push(`${ctx.getIfIndex(name)}:\t${name}`);
      // Every interface is permanently a member of the all-systems group.
      lines.push(`\tinet 224.0.0.1`);
      for (const g of byIface.get(name) ?? []) lines.push(`\tinet ${g}`);
    }
    return lines.join('\n');
  }

  if (cmd !== 'add' && cmd !== 'del' && cmd !== 'delete') {
    return `Command "${cmd}" is unknown, try "ip maddr help".`;
  }
  const group = positional[0];
  if (!group) return 'Not enough information: address is required.';
  if (!dev) return 'Not enough information: "dev" argument is required.';
  if (!ctx.getInterfaceInfo(dev)) return `Cannot find device "${dev}"`;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(group)) {
    return `Error: an inet address is expected rather than "${group}".`;
  }

  const ok = cmd === 'add' ? m.join(dev, group) : m.leave(dev, group);
  if (!ok) {
    return cmd === 'add'
      ? 'RTNETLINK answers: Invalid argument'
      : 'RTNETLINK answers: No such file or directory';
  }
  return '';
}

// ─── ip addr ────────────────────────────────────────────────────────

function ipAddr(ctx: IpNetworkContext, args: string[], opts: IpOutputOptions): string {
  if (args.length === 0 || args[0] === 'show' || args[0] === 'list') {
    return ipAddrShow(ctx, args.slice(args[0] === 'show' || args[0] === 'list' ? 1 : 0), opts);
  }
  if (args[0] === 'add') return ipAddrAdd(ctx, args.slice(1));
  if (args[0] === 'change') return ipAddrChangeOrReplace(ctx, args.slice(1), 'change');
  if (args[0] === 'replace') return ipAddrChangeOrReplace(ctx, args.slice(1), 'replace');
  if (args[0] === 'del' || args[0] === 'delete') return ipAddrDel(ctx, args.slice(1));
  if (args[0] === 'flush') return ipAddrFlush(ctx, args.slice(1));
  if (args[0] === 'help') return IP_ADDR_HELP;
  return `Command "${args[0]}" is unknown, try "ip addr help".`;
}

function ipAddrFlush(ctx: IpNetworkContext, args: string[]): string {
  // ip addr flush dev <name> — drop every address configured on the device.
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

function ipAddrShow(ctx: IpNetworkContext, args: string[], opts: IpOutputOptions): string {
  // Filter by "dev <name>" or a bare interface name (iproute2 accepts both).
  const SCOPE_KW = new Set(['scope', 'to', 'label', 'up', 'down', 'permanent', 'dynamic', 'primary', 'secondary']);
  let filterDev: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) { filterDev = args[i + 1]; break; }
    if (!filterDev && !args[i].startsWith('-') && args[i] !== 'show' && args[i] !== 'list'
      && !SCOPE_KW.has(args[i]) && !/^(scope|to|label)$/.test(args[i - 1] ?? '')) {
      filterDev = args[i];
    }
  }

  const allNames = ['lo', ...ctx.getInterfaceNames().filter(n => n !== 'lo')];

  if (filterDev) {
    const info = ctx.getInterfaceInfo(filterDev);
    if (!info) return `Device "${filterDev}" does not exist.`;
    const idx = ctx.getIfIndex(filterDev);
    if (opts.json) return toJsonText([buildAddrJsonEntry(info, idx, computeIfaceFlags(info), opts.family, opts.stats)], opts.pretty);
    const block = formatAddrInterface(info, idx, opts);
    return opts.oneline ? collapseOneline(block) : block;
  }

  if (opts.json) {
    const entries = [];
    for (let i = 0; i < allNames.length; i++) {
      const info = ctx.getInterfaceInfo(allNames[i]);
      if (!info) continue;
      entries.push(buildAddrJsonEntry(info, ctx.getIfIndex(allNames[i]), computeIfaceFlags(info), opts.family, opts.stats));
    }
    return toJsonText(entries, opts.pretty);
  }

  const blocks: string[] = [];
  for (let i = 0; i < allNames.length; i++) {
    const info = ctx.getInterfaceInfo(allNames[i]);
    if (!info) continue;
    blocks.push(formatAddrInterface(info, ctx.getIfIndex(allNames[i]), opts));
  }
  return opts.oneline ? blocks.map(collapseOneline).join('\n') : blocks.join('\n\n');
}

function collapseOneline(block: string): string {
  return block.split('\n').map(l => l.trim()).join(' ');
}

/**
 * Le `scope` d'une adresse IPv4, tel que le noyau le choisit : `host`
 * pour 127.0.0.0/8, qui ne quitte jamais la machine, `global` sinon.
 * C'est une propriété de l'adresse et non de l'interface qui la porte.
 */
function scopeIpv4(ip: string | null): string {
  return ip !== null && ip.startsWith('127.') ? 'host' : 'global';
}

/**
 * La forme d'un lien : son état opérationnel, sa file d'attente et sa
 * longueur de file.
 *
 * `ip addr` et `ip link` décrivent la MÊME interface et calculaient ces
 * trois faits chacun de leur côté, si bien qu'une machine annonçait
 * `state UNKNOWN` à l'une et `state UP` à l'autre pour `lo`, au même
 * instant. Une seule règle, deux vues.
 */
function formeLien(info: IpInterfaceInfo): { state: string; qdisc: string; qlen: string } {
  return {
    // `UNKNOWN` est l'état d'une interface dont la porteuse n'est pas
    // une question : c'est ce que `lo` et une `dummy` affichent sur une
    // vraie machine.
    state: info.carrierless ? 'UNKNOWN'
      : info.isUp && info.isConnected ? 'UP' : 'DOWN',
    // Pas de file sur une interface qui n'attend rien.
    qdisc: info.carrierless ? 'noqueue' : 'fq_codel',
    qlen: ` qlen ${info.txQueueLen ?? 1000}`,
  };
}

export function computeIfaceFlags(info: IpInterfaceInfo): string[] {
  const isLoopback = info.name === 'lo';
  const flags: string[] = [];

  if (isLoopback) {
    flags.push('LOOPBACK');
  } else {
    // `NO-CARRIER` n'a de sens que là où une porteuse peut manquer : une
    // interface `dummy` l'affichait, ce qu'aucun Linux n'écrit.
    if (info.isUp && !info.isConnected && !info.carrierless) flags.push('NO-CARRIER');
    flags.push('BROADCAST');
    // Rien à résoudre au bout d'une interface sans porteuse : le vrai
    // Linux marque `NOARP` là où une carte porte `MULTICAST`.
    if (info.carrierless) flags.push('NOARP');
  }
  if (info.isUp) flags.push('UP');
  // PROMISC is IFF bit 8 and MULTICAST bit 12, so the kernel lists it
  // first — that is the order iproute2 prints, not an arbitrary slot.
  if (info.promiscuous) flags.push('PROMISC');
  if (isLoopback) {
    flags.push('UP');
  } else if (!info.carrierless) {
    flags.push('MULTICAST');
  }
  if (info.isUp && info.isConnected) flags.push('LOWER_UP');

  return [...new Set(flags)];
}

function statsLines(info: IpInterfaceInfo): string[] {
  const c = info.counters;
  const errorsIn = c.errorsIn ?? 0;
  const errorsOut = c.errorsOut ?? 0;
  return [
    '    RX:  bytes packets errors dropped  missed   mcast',
    `    ${String(c.bytesIn).padStart(5)}${String(c.framesIn).padStart(8)}${String(errorsIn).padStart(7)}${'0'.padStart(8)}${'0'.padStart(8)}${'0'.padStart(8)}`,
    '    TX:  bytes packets errors dropped carrier collsns',
    `    ${String(c.bytesOut).padStart(5)}${String(c.framesOut).padStart(8)}${String(errorsOut).padStart(7)}${'0'.padStart(8)}${'0'.padStart(8)}${'0'.padStart(8)}`,
  ];
}

function formatAddrInterface(info: IpInterfaceInfo, idx: number, opts: IpOutputOptions): string {
  const isLoopback = info.name === 'lo';
  const uniqueFlags = computeIfaceFlags(info);
  const family = opts.family;

  const { state, qdisc, qlen } = formeLien(info);
  const group = 'default';

  const c = opts.color;
  const lines: string[] = [];
  lines.push(`${idx}: ${c.ifname(`${info.name}: `)}<${uniqueFlags.join(',')}> mtu ${info.mtu} qdisc ${qdisc}${info.master ? ` master ${info.master}` : ''} state ${c.operstate(state, `${state} `)}group ${group}${qlen}`);
  lines.push(`    link/${isLoopback ? 'loopback' : 'ether'} ${c.mac(String(info.mac))} brd ${c.mac(isLoopback ? '00:00:00:00:00:00' : 'ff:ff:ff:ff:ff:ff')}`);
  if (opts.stats) lines.push(...statsLines(info));

  if (family !== 'inet6' && info.ip && info.cidr !== null) {
    const dynFlag = info.isDHCP ? 'dynamic ' : '';
    // Le `scope` est une propriété de l'ADRESSE, pas de l'interface :
    // 127.0.0.0/8 ne sort jamais de la machine, une 10.0.0.1 posée sur
    // `lo` si (c'est tout l'intérêt de l'y poser). En le déduisant de
    // l'interface, une adresse ajoutée sur la boucle était annoncée
    // `scope host` — donc décrite comme injoignable alors qu'elle est
    // précisément là pour être annoncée par un démon de routage.
    const scope = scopeIpv4(info.ip);
    // Une adresse de bouclage n'a pas de broadcast : `ip` n'en imprime
    // aucun pour `127.0.0.1/8`, et nous en calculions un.
    const brd = isLoopback ? null : broadcastAddress(info.ip, info.cidr);
    // L'espace qui précède `scope` appartient à ce qui le précède : au
    // fragment colorié quand il y a un `brd`, à la chaîne nue sinon.
    const brdStr = brd ? ` brd ${c.inet(`${brd} `)}` : ' ';
    lines.push(`    inet ${c.inet(String(info.ip))}/${info.cidr}${brdStr}${dynFlag}scope ${scope} ${info.name}`);
    // La durée de vie manquait sur TOUTES les adresses IPv4 — mesuré sur
    // une vraie machine, où `eth0` la porte comme `lo`. Elle n'est
    // rendue que pour IPv6 auparavant, si bien que les deux familles
    // n'étaient pas décrites de la même façon sur la même interface.
    // `forever` est ce que ce simulateur modélise : la durée restante
    // d'un bail DHCP existe dans le moteur mais n'est pas acheminée
    // jusqu'à cette vue, et le fanion `dynamic` dit déjà l'origine.
    lines.push('       valid_lft forever preferred_lft forever');
    for (const sec of info.secondaryIPs ?? []) {
      const secBrd = isLoopback ? null : broadcastAddress(sec.ip, sec.cidr);
      lines.push(`    inet ${c.inet(String(sec.ip))}/${sec.cidr}${secBrd ? ` brd ${c.inet(`${secBrd} `)}` : ' '}scope ${scopeIpv4(sec.ip)} secondary ${info.name}`);
      lines.push('       valid_lft forever preferred_lft forever');
    }
  }

  if (family !== 'inet') {
    for (const v6 of info.ipv6 ?? []) {
      lines.push(`    inet6 ${c.inet6(String(v6.address))}/${v6.prefixLength} scope ${v6.scope}`);
      lines.push(`       valid_lft forever preferred_lft forever`);
    }
  }

  return lines.join('\n');
}

function ipAddrBrief(ctx: IpNetworkContext, args: string[], c: IpColorizer): string {
  const names = ['lo', ...ctx.getInterfaceNames().filter(n => n !== 'lo')];
  const lines: string[] = [];

  for (const name of names) {
    const info = ctx.getInterfaceInfo(name);
    if (!info) continue;
    const { state } = formeLien(info);
    // En mode bref, la couleur enveloppe la COLONNE complétée et non le
    // mot : le vrai `ip -br` colorie `eth0            ` d'un bloc, ce qui
    // se voit quand on aligne deux lignes l'une sous l'autre.
    const ipStr = info.ip && info.cidr !== null ? `${c.inet(String(info.ip))}/${info.cidr}` : '';
    // Left-pad name to 16 chars, state to 14 chars
    const nameCol = c.ifname(info.name.padEnd(16));
    const stateCol = c.operstate(state, state.padEnd(14));
    lines.push(`${nameCol}${stateCol}${ipStr}`);
  }

  return lines.join('\n');
}

function ipLinkBrief(ctx: IpNetworkContext, args: string[], c: IpColorizer): string {
  const demande = args.find((a) => a !== 'show' && a !== 'list' && a !== 'dev');
  const names = demande
    ? [demande]
    : ['lo', ...ctx.getInterfaceNames().filter((n) => n !== 'lo')];
  const lines: string[] = [];
  for (const name of names) {
    const info = ctx.getInterfaceInfo(name);
    if (!info) continue;
    const { state } = formeLien(info);
    const drapeaux = `<${computeIfaceFlags(info).join(',')}>`;
    lines.push(
      `${c.ifname(info.name.padEnd(16))}${c.operstate(state, state.padEnd(14))}`
      + `${(info.mac ?? '').padEnd(18)}${drapeaux}`,
    );
  }
  return lines.join('\n');
}

interface ParsedAddrArgs {
  addrStr: string;
  devName: string;
}

function parseAddrArgs(args: string[]): ParsedAddrArgs | string {
  let addrStr: string | null = null;
  let devName: string | null = null;
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) {
      devName = args[i + 1];
      i++;
    } else if (!addrStr && !args[i].startsWith('-')) {
      addrStr = args[i];
    } else {
      unknown.push(args[i]);
    }
  }

  if (!addrStr) return 'Error: either "local" or "peer" address is required.';
  if (unknown.length > 0) {
    return `Error: garbage instead of arguments "${unknown.join(' ')}", try "ip addr help".`;
  }
  if (!devName) return 'Not enough information: "dev" argument is required.';

  return { addrStr, devName };
}

function addrExistsOnDevice(info: IpInterfaceInfo, ipStr: string): boolean {
  if (info.ip === ipStr) return true;
  if ((info.secondaryIPs ?? []).some(s => s.ip === ipStr)) return true;
  if ((info.ipv6 ?? []).some(v6 => v6.address === ipStr)) return true;
  return false;
}

function ipAddrAdd(ctx: IpNetworkContext, args: string[]): string {
  // ip addr add <ip>/<cidr> dev <name>
  const parsed = parseAddrArgs(args);
  if (typeof parsed === 'string') return parsed;
  const { addrStr, devName } = parsed;

  const slashIdx = addrStr.indexOf('/');
  if (slashIdx === -1) return 'Error: either "local" or "peer" address is required.';

  const ipStr = addrStr.slice(0, slashIdx);
  const prefix = parseInt(addrStr.slice(slashIdx + 1), 10);
  const info = ctx.getInterfaceInfo(devName);

  if (ipStr.includes(':')) {
    if (isNaN(prefix) || prefix < 1 || prefix > 128) return 'Error: invalid prefix length.';
    if (!ctx.addInterfaceIPv6) return `Error: IPv6 address configuration is not supported on this interface.`;
    if (info && addrExistsOnDevice(info, ipStr)) return 'RTNETLINK answers: File exists';
    return ctx.addInterfaceIPv6(devName, ipStr, prefix);
  }

  if (isNaN(prefix) || prefix < 1 || prefix > 32) return 'Error: invalid prefix length.';
  let ip: IPAddress;
  try { ip = new IPAddress(ipStr); }
  catch { return `Error: ${ipStr} is not a valid IPv4 address.`; }

  if (info && addrExistsOnDevice(info, ipStr)) return 'RTNETLINK answers: File exists';

  return ctx.addInterfaceIP ? ctx.addInterfaceIP(devName, ip, prefix) : ctx.configureInterface(devName, ip, prefix);
}

function ipAddrChangeOrReplace(ctx: IpNetworkContext, args: string[], mode: 'change' | 'replace'): string {
  const parsed = parseAddrArgs(args);
  if (typeof parsed === 'string') return parsed;
  const { addrStr, devName } = parsed;

  const slashIdx = addrStr.indexOf('/');
  if (slashIdx === -1) return 'Error: either "local" or "peer" address is required.';
  const ipStr = addrStr.slice(0, slashIdx);
  const prefix = parseInt(addrStr.slice(slashIdx + 1), 10);
  if (ipStr.includes(':') || isNaN(prefix) || prefix < 1 || prefix > 32) {
    return `Error: "ip addr ${mode}" is only supported for IPv4 addresses.`;
  }
  let ip: IPAddress;
  try { ip = new IPAddress(ipStr); }
  catch { return `Error: ${ipStr} is not a valid IPv4 address.`; }

  const info = ctx.getInterfaceInfo(devName);
  if (!info) return `Cannot find device "${devName}"`;

  const isPrimary = info.ip === ipStr;
  const isSecondary = (info.secondaryIPs ?? []).some(s => s.ip === ipStr);

  if (mode === 'change' && !isPrimary && !isSecondary) {
    return 'RTNETLINK answers: Cannot assign requested address';
  }

  if (isPrimary) return ctx.configureInterface(devName, ip, prefix);
  if (isSecondary && ctx.removeInterfaceAddress) ctx.removeInterfaceAddress(devName, ip);

  return ctx.addInterfaceIP ? ctx.addInterfaceIP(devName, ip, prefix) : ctx.configureInterface(devName, ip, prefix);
}

function ipAddrDel(ctx: IpNetworkContext, args: string[]): string {
  // ip addr del <ip>/<cidr> dev <name>
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

  if (!devName) return 'Not enough information: "dev" argument is required.';

  if (addrStr) {
    const ipStr = addrStr.split('/')[0];
    let ip: IPAddress;
    try { ip = new IPAddress(ipStr); }
    catch { return 'RTNETLINK answers: Cannot assign requested address'; }
    if (ctx.removeInterfaceAddress) return ctx.removeInterfaceAddress(devName, ip);
    const info = ctx.getInterfaceInfo(devName);
    if (info && info.ip !== ipStr) {
      return 'RTNETLINK answers: Cannot assign requested address';
    }
  }

  return ctx.removeInterfaceIP(devName);
}

// ─── ip link ────────────────────────────────────────────────────────

function ipLink(ctx: IpNetworkContext, args: string[], opts: IpOutputOptions): string {
  if (args.length === 0 || args[0] === 'show' || args[0] === 'list') {
    return ipLinkShow(ctx, args.slice(args[0] === 'show' || args[0] === 'list' ? 1 : 0), opts);
  }
  if (args[0] === 'set') return ipLinkSet(ctx, args.slice(1));
  if (args[0] === 'add') return ipLinkAdd(ctx, args.slice(1));
  if (args[0] === 'del' || args[0] === 'delete') return ipLinkDel(ctx, args.slice(1));
  if (args[0] === 'help') return IP_LINK_HELP;
  return `Command "${args[0]}" is unknown, try "ip link help".`;
}

function ipLinkAdd(ctx: IpNetworkContext, args: string[]): string {
  const linkOps = ctx.linkOps;
  if (!linkOps) return 'RTNETLINK answers: Operation not supported';

  let name: string | null = null;
  let linkDev: string | null = null;
  let type: string | null = null;
  let peerName: string | null = null;
  let vlanId: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'name' && args[i + 1]) { name = args[++i]; }
    else if (args[i] === 'link' && args[i + 1]) { linkDev = args[++i]; }
    else if (args[i] === 'type' && args[i + 1]) { type = args[++i]; }
    else if (args[i] === 'peer' && args[i + 1] === 'name' && args[i + 2]) { peerName = args[i + 2]; i += 2; }
    else if (args[i] === 'id' && args[i + 1]) { vlanId = parseInt(args[++i], 10); }
    else if (!name && !args[i].startsWith('-')) { name = args[i]; }
  }

  if (!name) return 'Error: not enough information to identify the device.';
  if (!type) return 'Error: "type" is a required argument, try "ip link help".';

  if (type === 'dummy') return linkOps.addDummy(name);

  if (type === 'bond') return linkOps.addBond(name);

  if (type === 'veth') {
    if (!peerName) return 'Error: veth requires "peer name NAME2".';
    return linkOps.addVeth(name, peerName);
  }

  if (type === 'vlan') {
    if (!linkDev) return 'Error: vlan requires "link DEV".';
    if (vlanId === undefined || isNaN(vlanId)) return 'Error: vlan requires "id VLANID".';
    return linkOps.addVlan(name, linkDev, vlanId);
  }

  return `Error: unknown link type "${type}", try "ip link help".`;
}

function ipLinkDel(ctx: IpNetworkContext, args: string[]): string {
  const linkOps = ctx.linkOps;
  if (!linkOps) return 'RTNETLINK answers: Operation not supported';
  const name = args[0];
  if (!name) return 'Usage: ip link delete DEVICE';
  return linkOps.deleteLink(name);
}

function ipLinkShow(ctx: IpNetworkContext, args: string[], opts: IpOutputOptions): string {
  const SHOW_KW = new Set(['up', 'master', 'vrf', 'type', 'group']);
  let filterDev: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) { filterDev = args[i + 1]; break; }
    if (!filterDev && !args[i].startsWith('-') && !SHOW_KW.has(args[i])
      && !/^(master|vrf|type|group)$/.test(args[i - 1] ?? '')) {
      filterDev = args[i];
    }
  }

  const names = ['lo', ...ctx.getInterfaceNames().filter(n => n !== 'lo')];

  if (filterDev) {
    const info = ctx.getInterfaceInfo(filterDev);
    if (!info) return `Device "${filterDev}" does not exist.`;
    const idx = ctx.getIfIndex(filterDev);
    if (opts.json) return toJsonText([buildLinkJsonEntry(info, idx, computeIfaceFlags(info), opts.stats)], opts.pretty);
    const block = formatLinkInterface(info, idx, opts.stats, opts.color);
    return opts.oneline ? collapseOneline(block) : block;
  }

  if (opts.json) {
    const entries = [];
    for (let i = 0; i < names.length; i++) {
      const info = ctx.getInterfaceInfo(names[i]);
      if (!info) continue;
      entries.push(buildLinkJsonEntry(info, ctx.getIfIndex(names[i]), computeIfaceFlags(info), opts.stats));
    }
    return toJsonText(entries, opts.pretty);
  }

  const blocks: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const info = ctx.getInterfaceInfo(names[i]);
    if (!info) continue;
    blocks.push(formatLinkInterface(info, ctx.getIfIndex(names[i]), opts.stats, opts.color));
  }
  return opts.oneline ? blocks.map(collapseOneline).join('\n') : blocks.join('\n\n');
}

function formatLinkInterface(
  info: IpInterfaceInfo, idx: number, stats = false, c: IpColorizer = ipColorizer(false),
): string {
  const isLoopback = info.name === 'lo';
  const uniqueFlags = computeIfaceFlags(info);

  const { state, qdisc, qlen } = formeLien(info);
  const mode = 'DEFAULT';
  const group = 'default';

  const lines: string[] = [];
  const maitre = info.master ? ` master ${info.master}` : '';
  lines.push(`${idx}: ${c.ifname(`${info.name}: `)}<${uniqueFlags.join(',')}> mtu ${info.mtu} qdisc ${qdisc}${maitre} state ${c.operstate(state, `${state} `)}mode ${mode} group ${group}${qlen}`);
  lines.push(`    link/${isLoopback ? 'loopback' : 'ether'} ${c.mac(String(info.mac))} brd ${c.mac(isLoopback ? '00:00:00:00:00:00' : 'ff:ff:ff:ff:ff:ff')}`);
  if (stats) lines.push(...statsLines(info));

  return lines.join('\n');
}

export type IpMonitorObject = 'link' | 'addr' | 'route' | 'neigh';

export interface IpMonitorLinkChange {
  iface: string;
}

export interface IpMonitorAddrChange {
  iface: string;
  ip: string;
  cidr: number;
  deleted: boolean;
}

export interface IpMonitorRouteChange {
  destination: string;
  mask: string;
  gateway: string | null;
  iface: string;
  metric: number;
  deleted: boolean;
}

export interface IpMonitorNeighChange {
  ip: string;
  mac: string;
  iface: string;
  state: string;
  deleted: boolean;
}

export interface IpMonitorSpec {
  objects: Set<IpMonitorObject>;
  labelled: boolean;
}

const IP_MONITOR_ALIASES: Record<string, IpMonitorObject> = {
  link: 'link', l: 'link',
  address: 'addr', addr: 'addr', a: 'addr',
  route: 'route', r: 'route',
  neigh: 'neigh', neighbour: 'neigh', neighbor: 'neigh', n: 'neigh',
};

const IP_MONITOR_ALL: IpMonitorObject[] = ['link', 'addr', 'route', 'neigh'];

export function parseIpMonitorSpec(args: string[]): IpMonitorSpec | { error: string } {
  if (args.length === 0) return { objects: new Set(IP_MONITOR_ALL), labelled: true };
  const objects = new Set<IpMonitorObject>();
  for (const arg of args) {
    if (arg === 'all') { for (const o of IP_MONITOR_ALL) objects.add(o); continue; }
    const mapped = IP_MONITOR_ALIASES[arg];
    if (!mapped) return { error: `Error: argument "${arg}" is wrong: unknown object, try "ip monitor help".` };
    objects.add(mapped);
  }
  return { objects, labelled: objects.size > 1 };
}

function monitorLabel(object: IpMonitorObject, labelled: boolean): string {
  if (!labelled) return '';
  switch (object) {
    case 'link': return '[LINK]';
    case 'addr': return '[ADDR]';
    case 'route': return '[ROUTE]';
    case 'neigh': return '[NEIGH]';
  }
}

export function formatIpMonitorLink(
  ctx: IpNetworkContext, change: IpMonitorLinkChange, labelled: boolean,
): string | null {
  const info = ctx.getInterfaceInfo(change.iface);
  if (!info) return null;
  const idx = ctx.getIfIndex(change.iface);
  return monitorLabel('link', labelled) + formatLinkInterface(info, idx);
}

export function formatIpMonitorAddr(
  ctx: IpNetworkContext, change: IpMonitorAddrChange, labelled: boolean,
): string {
  const idx = ctx.getIfIndex(change.iface);
  const brd = broadcastAddress(change.ip, change.cidr);
  const brdStr = brd ? ` brd ${brd}` : '';
  const head = `${idx}: ${change.iface}    inet ${change.ip}/${change.cidr}${brdStr} scope global ${change.iface}`;
  const body = '       valid_lft forever preferred_lft forever';
  const prefix = monitorLabel('addr', labelled) + (change.deleted ? 'Deleted ' : '');
  return `${prefix}${head}\n${body}`;
}

export function formatIpMonitorRoute(change: IpMonitorRouteChange, labelled: boolean): string {
  const cidr = new SubnetMask(change.mask).toCIDR();
  const dest = cidr === 0 ? 'default' : `${change.destination}/${cidr}`;
  const via = change.gateway ? ` via ${change.gateway}` : '';
  const metricStr = change.metric > 0 ? ` metric ${change.metric}` : '';
  const line = `${dest}${via} dev ${change.iface}${metricStr}`;
  const prefix = monitorLabel('route', labelled) + (change.deleted ? 'Deleted ' : '');
  return `${prefix}${line}`;
}

export function formatIpMonitorNeigh(change: IpMonitorNeighChange, labelled: boolean): string {
  const dev = change.iface ? ` dev ${change.iface}` : '';
  const lladdr = change.mac ? ` lladdr ${change.mac}` : '';
  const line = `${change.ip}${dev}${lladdr} ${change.state}`;
  const prefix = monitorLabel('neigh', labelled) + (change.deleted ? 'Deleted ' : '');
  return `${prefix}${line}`;
}

function ipLinkSet(ctx: IpNetworkContext, args: string[]): string {
  if (args.length === 0) return 'Not enough information: arguments are required.';

  // ip link set <dev> { up | down | mtu MTU }
  // ip link set dev <dev> { up | down | mtu MTU }
  let devName: string | null = null;
  let action: string | null = null;
  let mtu: number | null = null;
  let lladdr: string | null = null;
  let txqueuelen: number | null = null;
  let promisc: boolean | null = null;
  let master: string | null = null;
  let detacher = false;
  const optionsBond: Array<[string, string]> = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) {
      devName = args[i + 1];
      i++;
    } else if (args[i] === 'up' || args[i] === 'down') {
      action = args[i];
    } else if (args[i] === 'mtu' && args[i + 1]) {
      mtu = parseInt(args[i + 1], 10);
      i++;
    } else if ((args[i] === 'address' || args[i] === 'addr') && args[i + 1]) {
      lladdr = args[i + 1];
      i++;
    } else if ((args[i] === 'txqueuelen' || args[i] === 'txqlen') && args[i + 1]) {
      txqueuelen = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === 'promisc' && args[i + 1]) {
      promisc = args[i + 1] === 'on';
      i++;
    } else if (args[i] === 'type' && args[i + 1] === 'bond') {
      i++;
      while (i + 2 < args.length) {
        optionsBond.push([args[i + 1], args[i + 2]]);
        i += 2;
      }
    } else if (args[i] === 'master' && args[i + 1]) {
      master = args[i + 1];
      i++;
    } else if (args[i] === 'nomaster') {
      master = null;
      detacher = true;
    } else if (!devName && !args[i].startsWith('-')) {
      devName = args[i];
    } else {
      // Everything unrecognised used to fall through this loop and the
      // command returned success. `ip link set eth0 address <mac>` was
      // therefore accepted and did nothing at all — silence on a
      // command that changes the machine's L2 identity.
      return `Error: either "dev" is duplicate, or "${args[i]}" is a garbage.`;
    }
  }

  if (!devName) return 'Not enough information: arguments are required.';

  if (mtu !== null) {
    if (isNaN(mtu)) return 'Error: argument "mtu" is wrong: invalid numeric value';
    const mtuResult = ctx.setInterfaceMTU(devName, mtu);
    if (mtuResult) return mtuResult;
  }

  if (lladdr !== null) {
    const macResult = ctx.setInterfaceMac(devName, lladdr);
    if (macResult) return macResult;
  }

  if (txqueuelen !== null) {
    if (isNaN(txqueuelen) || txqueuelen < 0) {
      return 'Error: argument "txqueuelen" is wrong: invalid numeric value';
    }
    const r = ctx.setInterfaceTxQueueLen(devName, txqueuelen);
    if (r) return r;
  }

  if (promisc !== null) {
    const r = ctx.setInterfacePromiscuous(devName, promisc);
    if (r) return r;
  }

  if (optionsBond.length > 0) {
    const ops = ctx.linkOps;
    if (!ops) return 'RTNETLINK answers: Operation not supported';
    for (const [cle, valeur] of optionsBond) {
      if (!ops.bondOption(devName, cle, valeur)) {
        return `Error: argument "${cle}" is wrong: invalid value`;
      }
    }
  }

  if (master !== null || detacher) {
    const ops = ctx.linkOps;
    if (!ops) return 'RTNETLINK answers: Operation not supported';
    const r = master !== null ? ops.enslave(master, devName) : ops.release(devName);
    if (r) return r;
  }

  if (action === 'up') return ctx.setInterfaceUp(devName);
  if (action === 'down') return ctx.setInterfaceDown(devName);

  return '';
}

// ─── ip route ───────────────────────────────────────────────────────

function parseTableArg(args: string[]): number | undefined {
  const idx = args.indexOf('table');
  if (idx === -1 || !args[idx + 1]) return undefined;
  const id = parseInt(args[idx + 1], 10);
  return isNaN(id) ? undefined : id;
}

function ipRoute(ctx: IpNetworkContext, args: string[], opts: IpOutputOptions): string {
  if (args.length === 0 || args[0] === 'show' || args[0] === 'list') {
    return ipRouteShow(ctx, args.slice(args[0] === 'show' || args[0] === 'list' ? 1 : 0), opts);
  }
  if (args[0] === 'add') return ipRouteAdd(ctx, args.slice(1));
  if (args[0] === 'append') return ipRouteAppend(ctx, args.slice(1));
  if (args[0] === 'replace') return ipRouteReplace(ctx, args.slice(1));
  if (args[0] === 'change') return ipRouteChange(ctx, args.slice(1));
  if (args[0] === 'del' || args[0] === 'delete') return ipRouteDel(ctx, args.slice(1));
  if (args[0] === 'get') return ipRouteGet(ctx, args.slice(1));
  if (args[0] === 'help') return IP_ROUTE_HELP;
  return `Command "${args[0]}" is unknown, try "ip route help".`;
}

function ipRouteShow(ctx: IpNetworkContext, args: string[], opts: IpOutputOptions): string {
  const tableId = parseTableArg(args);
  const table = ctx.getRoutingTable(tableId);
  if (table.length === 0) return opts.json ? toJsonText([], opts.pretty) : '';

  // Sort: connected first, then static, then default
  const sorted = [...table].sort((a, b) => {
    const order: Record<string, number> = { connected: 0, static: 1, default: 2 };
    return (order[a.type] ?? 9) - (order[b.type] ?? 9);
  });

  if (opts.json) return toJsonText(sorted.map(buildRouteJsonEntry), opts.pretty);

  // Sur une route, le préfixe est DANS la couleur (`10.0.0.0/24 `) alors
  // qu'il en sort sur une adresse d'interface (`10.0.0.1` puis `/24`) :
  // deux formats d'impression distincts dans iproute2, tous deux mesurés.
  const c = opts.color;
  const reseau = (r: IpRouteEntry) => c.inet(`${r.network}/${r.cidr} `);
  const dev = (r: IpRouteEntry) => c.ifname(`${r.iface} `);

  const lines: string[] = [];
  for (const route of sorted) {
    // A route whose interface has no carrier stays listed, with the flag
    // the kernel sets on it — that is what tells an operator the route
    // exists but nothing can leave through it.
    const dead = route.linkdown ? ' linkdown' : '';
    if (route.type === 'default') {
      const proto = route.isDHCP ? 'dhcp' : 'static';
      const metricStr = route.metric > 0 ? ` metric ${route.metric}` : '';
      lines.push(`default via ${c.inet(`${route.nextHop} `)}dev ${dev(route)}proto ${proto}${metricStr}${dead}`);
    } else if (route.type === 'connected') {
      const srcStr = route.srcIp ? ` src ${c.inet(String(route.srcIp))}` : '';
      lines.push(`${reseau(route)}dev ${dev(route)}proto kernel scope link${srcStr} metric ${route.metric}${dead}`);
    } else if (route.nextHop) {
      // static via a gateway
      lines.push(`${reseau(route)}via ${c.inet(`${route.nextHop} `)}dev ${dev(route)}proto static metric ${route.metric}${dead}`);
    } else {
      // static on-link (dev route, no gateway)
      lines.push(`${reseau(route)}dev ${dev(route)}proto static scope link metric ${route.metric}${dead}`);
    }
  }

  return lines.join('\n');
}

function ipRoute6(ctx: IpNetworkContext, args: string[], opts: IpOutputOptions): string {
  if (args.length > 0 && args[0] !== 'show' && args[0] !== 'list') {
    if (args[0] === 'help') return IP_ROUTE_HELP;
    return `Command "${args[0]}" is unknown, try "ip route help".`;
  }
  const table = ctx.getIPv6RoutingTable?.() ?? [];

  if (opts.json) {
    const entries = table.map(route => ({
      dst: route.type === 'default' ? 'default' : `${route.prefix}/${route.prefixLength}`,
      gateway: route.nextHop ?? undefined,
      dev: route.iface,
      protocol: route.type === 'connected' ? 'kernel' : (route.type === 'ra' ? 'ra' : 'static'),
      metric: route.metric,
      flags: [] as string[],
    }));
    return toJsonText(entries, opts.pretty);
  }

  const c = opts.color;
  const lines: string[] = [];
  for (const route of table) {
    const proto = route.type === 'connected' ? 'kernel'
      : route.type === 'ra' ? 'ra' : 'static';
    const dest = route.type === 'default'
      ? 'default '
      : c.inet6(`${route.prefix}/${route.prefixLength} `);
    const via = route.nextHop ? `via ${c.inet6(`${route.nextHop} `)}` : '';
    lines.push(`${dest}${via}dev ${c.ifname(`${route.iface} `)}proto ${proto} metric ${route.metric} pref medium`);
  }
  return lines.join('\n');
}

interface ParsedRouteSpec {
  isDefault: boolean;
  network: IPAddress;
  cidr: number;
  gateway: IPAddress | null;
  dev: string | null;
  metric?: number;
  table?: number;
}

function parseRouteSpec(args: string[]): ParsedRouteSpec | string {
  // <default | net/cidr> [via <gw>] [dev <iface>] [metric <n>]
  if (args.length === 0) return 'Error: need a valid prefix or "default".';

  const isDefault = args[0] === 'default';
  let network: IPAddress;
  let cidr: number;

  if (isDefault) {
    network = new IPAddress('0.0.0.0');
    cidr = 0;
  } else {
    const prefix = args[0];
    const slashIdx = prefix.indexOf('/');
    if (slashIdx === -1) return 'Error: invalid prefix (expected <network>/<cidr>).';
    const networkStr = prefix.slice(0, slashIdx);
    cidr = parseInt(prefix.slice(slashIdx + 1), 10);
    if (isNaN(cidr) || cidr < 0 || cidr > 32) return 'Error: invalid prefix length.';
    try { network = new IPAddress(networkStr); }
    catch { return `Error: ${networkStr} is not a valid IPv4 address.`; }
  }

  const devIdx = args.indexOf('dev');
  const viaIdx = args.indexOf('via');
  const metricIdx = args.indexOf('metric');

  let gateway: IPAddress | null = null;
  if (viaIdx !== -1 && args[viaIdx + 1]) {
    try { gateway = new IPAddress(args[viaIdx + 1]); }
    catch { return `Error: ${args[viaIdx + 1]} is not a valid IPv4 address.`; }
  }
  if (isDefault && !gateway) return 'Error: "via" is required for default route.';

  const dev = devIdx !== -1 && args[devIdx + 1] ? args[devIdx + 1] : null;
  let metric: number | undefined;
  if (metricIdx !== -1 && args[metricIdx + 1]) metric = parseInt(args[metricIdx + 1], 10);
  const table = parseTableArg(args);

  return { isDefault, network, cidr, gateway, dev, metric, table };
}

type RouteMode = 'add' | 'append' | 'replace' | 'change';

function applyRouteSpec(ctx: IpNetworkContext, spec: ParsedRouteSpec, mode: RouteMode): string {
  const { isDefault, network, cidr, gateway, dev, metric, table } = spec;
  const tableId = table ?? 254;

  if (isDefault) {
    if (tableId === 254) {
      if (mode === 'change' && !ctx.getRoutingTable().some(r => r.type === 'default')) {
        return 'RTNETLINK answers: No such process';
      }
      return ctx.addDefaultRoute(gateway!);
    }
    if (mode === 'change' && !ctx.getRoutingTable(tableId).some(r => r.type === 'default')) {
      return 'RTNETLINK answers: No such process';
    }
    return ctx.addStaticRoute(network, cidr, gateway!, metric, { allowDuplicate: mode !== 'add', table: tableId });
  }

  if (mode === 'replace' || mode === 'change') {
    const existing = ctx.getRoutingTable(tableId).some(
      r => r.type !== 'connected' && r.network === network.toString() && r.cidr === cidr,
    );
    if (mode === 'change' && !existing) return 'RTNETLINK answers: No such process';
    if (existing) ctx.deleteRoute(network, cidr, { table: tableId });
  }

  if (!gateway) {
    if (!dev) return 'Error: "via" is required.';
    if (!ctx.addDeviceRoute) return `Cannot find device "${dev}"`;
    return ctx.addDeviceRoute(network, cidr, dev, tableId);
  }

  const allowDuplicate = mode !== 'add';
  return ctx.addStaticRoute(network, cidr, gateway, metric, { allowDuplicate, table: tableId });
}

function ipRouteAdd(ctx: IpNetworkContext, args: string[]): string {
  const spec = parseRouteSpec(args);
  if (typeof spec === 'string') return spec;
  return applyRouteSpec(ctx, spec, 'add');
}

function ipRouteAppend(ctx: IpNetworkContext, args: string[]): string {
  const spec = parseRouteSpec(args);
  if (typeof spec === 'string') return spec;
  return applyRouteSpec(ctx, spec, 'append');
}

function ipRouteReplace(ctx: IpNetworkContext, args: string[]): string {
  const spec = parseRouteSpec(args);
  if (typeof spec === 'string') return spec;
  return applyRouteSpec(ctx, spec, 'replace');
}

function ipRouteChange(ctx: IpNetworkContext, args: string[]): string {
  const spec = parseRouteSpec(args);
  if (typeof spec === 'string') return spec;
  return applyRouteSpec(ctx, spec, 'change');
}

function ipRouteDel(ctx: IpNetworkContext, args: string[]): string {
  if (args.length === 0) return 'Error: need a valid prefix or "default".';

  if (args[0] === 'default') {
    return ctx.deleteDefaultRoute();
  }

  // Delete static: <net>/<cidr> [via <gw>] [metric <n>]
  const prefix = args[0];
  const slashIdx = prefix.indexOf('/');
  if (slashIdx === -1) return 'Error: invalid prefix.';

  const networkStr = prefix.slice(0, slashIdx);
  const cidr = parseInt(prefix.slice(slashIdx + 1), 10);
  if (isNaN(cidr)) return 'Error: invalid prefix.';
  let network: IPAddress;
  try { network = new IPAddress(networkStr); }
  catch { return `Error: ${networkStr} is not a valid IPv4 address.`; }

  const filter: { nextHop?: IPAddress | null; metric?: number; table?: number } = {};
  const viaIdx = args.indexOf('via');
  if (viaIdx !== -1 && args[viaIdx + 1]) {
    try { filter.nextHop = new IPAddress(args[viaIdx + 1]); }
    catch { return `Error: ${args[viaIdx + 1]} is not a valid IPv4 address.`; }
  }
  const metricIdx = args.indexOf('metric');
  if (metricIdx !== -1 && args[metricIdx + 1]) {
    const m = parseInt(args[metricIdx + 1], 10);
    if (!isNaN(m)) filter.metric = m;
  }
  const tableId = parseTableArg(args);
  if (tableId !== undefined) filter.table = tableId;

  return ctx.deleteRoute(network, cidr, filter);
}

function ipRouteGet(ctx: IpNetworkContext, args: string[]): string {
  if (args.length === 0) return 'Error: need a valid destination address.';

  const dest = args[0];
  const destAddr = IPAddress.tryParse(dest);
  if (!destAddr) return `Error: ${dest} is not a valid IPv4 address.`;

  const fromIdx = args.indexOf('from');
  if (fromIdx !== -1 && args[fromIdx + 1] && ctx.resolveRouteWithRules) {
    const fromAddr = IPAddress.tryParse(args[fromIdx + 1]);
    if (!fromAddr) return `Error: ${args[fromIdx + 1]} is not a valid IPv4 address.`;
    const resolved = ctx.resolveRouteWithRules(destAddr, fromAddr);
    if (!resolved) return `RTNETLINK answers: Network is unreachable`;
    const iface = ctx.getInterfaceInfo(resolved.iface);
    const src = iface?.ip ?? undefined;
    const suffix = src ? ` src ${src}` : '';
    const tableSuffix = resolved.table !== 254 ? ` table ${resolved.table}` : '';
    if (resolved.nextHopIP === dest) {
      return `${dest} from ${fromAddr} dev ${resolved.iface}${suffix}${tableSuffix}`;
    }
    return `${dest} from ${fromAddr} via ${resolved.nextHopIP} dev ${resolved.iface}${suffix}${tableSuffix}`;
  }

  const table = ctx.getRoutingTable();
  const best = pickBestRoute(destAddr, table);
  if (!best) return `RTNETLINK answers: Network is unreachable`;

  const iface = ctx.getInterfaceInfo(best.iface);
  const src = iface?.ip ?? undefined;

  if (best.type === 'default') {
    const suffix = src ? ` src ${src}` : '';
    return `${dest} via ${best.nextHop} dev ${best.iface}${suffix}`;
  }
  if (best.nextHop) {
    const suffix = src ? ` src ${src}` : '';
    return `${dest} via ${best.nextHop} dev ${best.iface}${suffix}`;
  }
  const suffix = src ? ` src ${src}` : (best.srcIp ? ` src ${best.srcIp}` : '');
  return `${dest} dev ${best.iface}${suffix}`;
}

function pickBestRoute(dest: IPAddress, table: IpRouteEntry[]): IpRouteEntry | null {
  const destInt = dest.toUint32();
  let best: IpRouteEntry | null = null;
  let bestPrefix = -1;
  for (const route of table) {
    const cidr = route.type === 'default' ? 0 : route.cidr;
    const mask = SubnetMask.fromCIDR(cidr).toUint32();
    const netParsed = IPAddress.tryParse(route.network);
    const netInt = netParsed ? netParsed.toUint32() : 0;
    if ((destInt & mask) !== (netInt & mask)) continue;
    if (cidr > bestPrefix
      || (cidr === bestPrefix && best !== null && route.metric < best.metric)) {
      bestPrefix = cidr;
      best = route;
    }
  }
  return best;
}

function isInSubnet(ip: string, network: string, cidr: number): boolean {
  const a = IPAddress.tryParse(ip);
  const n = IPAddress.tryParse(network);
  if (!a || !n) return false;
  const m = SubnetMask.fromCIDR(cidr);
  return a.networkAddress(m).equals(n.networkAddress(m));
}

// ─── ip neigh ───────────────────────────────────────────────────────

function ipNeigh(ctx: IpNetworkContext, args: string[], opts: IpOutputOptions): string {
  const sub = args[0] ?? 'show';

  if (sub === 'show' || sub === 'list') {
    return ipNeighShow(ctx, args.slice(1), opts);
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
  return ipNeighShow(ctx, args, opts);
}

function ipNeighShow(ctx: IpNetworkContext, args: string[], opts: IpOutputOptions): string {
  // Optional filters: a target address and/or `dev <iface>`.
  let addr: string | null = null;
  let devFilter: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) { devFilter = args[++i]; }
    else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(args[i])) addr = args[i];
  }

  let neighbors = ctx.getNeighborTable();
  if (devFilter) neighbors = neighbors.filter(n => n.iface === devFilter);
  if (addr) neighbors = neighbors.filter(n => n.ip === addr);
  if (neighbors.length > 0) {
    if (opts.json) return toJsonText(neighbors.map(buildNeighJsonEntry), opts.pretty);
    const c = opts.color;
    return neighbors
      .map(n => n.state === 'FAILED'
        ? `${c.inet(`${n.ip} `)}dev ${c.ifname(`${n.iface} `)} FAILED`
        : `${c.inet(`${n.ip} `)}dev ${c.ifname(`${n.iface} `)}lladdr ${c.mac(`${n.mac} `)}${n.state}`)
      .join('\n');
  }

  // A specific on-link address with no cache entry: when the peer is
  // unreachable (powered off, NIC down, off-topology) the kernel keeps a
  // FAILED entry. A reachable-but-unprobed peer simply has no entry.
  if (addr) {
    const route = ctx.getRoutingTable().find(
      r => r.type === 'connected' && isInSubnet(addr!, r.network, r.cidr),
    );
    if (route) {
      const found = findHostByAddress(addr, undefined, ctx.getLocalDevice?.() as never);
      if (!found || found.poweredOff || found.interfaceDown) {
        if (opts.json) return toJsonText([{ dst: addr, dev: route.iface, state: ['FAILED'] }], opts.pretty);
        return `${opts.color.inet(`${addr} `)}dev ${opts.color.ifname(`${route.iface} `)} FAILED`;
      }
    }
  }
  return opts.json ? toJsonText([], opts.pretty) : '';
}

// ip neigh add <IP> lladdr <MAC> dev <DEV> [nud permanent|static]
function ipNeighAdd(ctx: IpNetworkContext, args: string[]): string {
  const ipStr = args[0];
  if (!ipStr) return 'Usage: ip neigh add ADDRESS lladdr LLADDR dev DEV';
  let ip: IPAddress;
  try { ip = new IPAddress(ipStr); }
  catch { return 'RTNETLINK answers: Invalid argument'; }

  let macStr: string | null = null;
  let dev: string | null = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === 'lladdr' && args[i + 1]) { macStr = args[++i]; }
    else if (args[i] === 'dev' && args[i + 1]) { dev = args[++i]; }
    else if (args[i] === 'nud') { i++; } // accept but ignore (always static)
  }

  if (!macStr) return 'RTNETLINK answers: Invalid argument (missing lladdr)';
  if (!dev) return 'RTNETLINK answers: Invalid argument (missing dev)';
  let mac: MACAddress;
  try { mac = new MACAddress(macStr); }
  catch { return 'RTNETLINK answers: Invalid argument'; }

  return ctx.addNeighbor(ip, mac, dev);
}

// ip neigh del <IP> dev <DEV>
function ipNeighDel(ctx: IpNetworkContext, args: string[]): string {
  const ipStr = args[0];
  if (!ipStr) return 'Usage: ip neigh del ADDRESS dev DEV';
  let ip: IPAddress;
  try { ip = new IPAddress(ipStr); }
  catch { return 'RTNETLINK answers: Invalid argument'; }

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

// ─── ip tunnel ──────────────────────────────────────────────────────

const IP_TUNNEL_HELP = `Usage: ip tunnel { add | change | del | show } [ NAME ]
          [ mode gre ]
          [ remote ADDR ] local ADDR
          [ key KEY ] [ ttl TTL ]`;

function ipTunnel(ctx: IpNetworkContext, args: string[]): string {
  if (args.length === 0 || args[0] === 'show' || args[0] === 'list') {
    return ipTunnelShow(ctx, args.slice(args[0] === 'show' || args[0] === 'list' ? 1 : 0));
  }
  if (args[0] === 'add' || args[0] === 'change') return ipTunnelAdd(ctx, args.slice(1));
  if (args[0] === 'del' || args[0] === 'delete') return ipTunnelDel(ctx, args.slice(1));
  if (args[0] === 'help') return IP_TUNNEL_HELP;
  return `Command "${args[0]}" is unknown, try "ip tunnel help".`;
}

function ipTunnelAdd(ctx: IpNetworkContext, args: string[]): string {
  const tunnel = ctx.tunnel;
  if (!tunnel) return 'RTNETLINK answers: Operation not supported';

  let name: string | null = null;
  let mode: string | null = null;
  let local: string | null = null;
  let remote: string | null = null;
  let key: number | undefined;
  let ttl: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'mode') mode = args[++i];
    else if (args[i] === 'local') local = args[++i];
    else if (args[i] === 'remote') remote = args[++i];
    else if (args[i] === 'key') key = parseInt(args[++i], 10);
    else if (args[i] === 'ttl') ttl = parseInt(args[++i], 10);
    else if (!name && !args[i].startsWith('-')) name = args[i];
  }

  if (!name) return 'Usage: ip tunnel add NAME mode gre remote ADDR local ADDR';
  if (mode !== 'gre') return 'Error: cannot determine tunnel mode (only "gre" is supported)';
  if (!remote) return 'Error: "remote" address is required.';
  if (!local) return 'Error: "local" address is required.';

  try { new IPAddress(local); } catch { return `Error: ${local} is not a valid IPv4 address.`; }
  try { new IPAddress(remote); } catch { return `Error: ${remote} is not a valid IPv4 address.`; }

  return tunnel.addTunnel(name, local, remote, { key, ttl });
}

function ipTunnelDel(ctx: IpNetworkContext, args: string[]): string {
  const tunnel = ctx.tunnel;
  if (!tunnel) return 'RTNETLINK answers: Operation not supported';
  const name = args[0];
  if (!name) return 'Usage: ip tunnel del NAME';
  return tunnel.removeTunnel(name);
}

function ipTunnelShow(ctx: IpNetworkContext, args: string[]): string {
  const tunnel = ctx.tunnel;
  if (!tunnel) return '';
  const filterName = args[0];
  const tunnels = tunnel.listTunnels().filter(t => !filterName || t.name === filterName);
  return tunnels.map(t => {
    const keyStr = t.key !== undefined ? ` key ${t.key}` : '';
    const ttlStr = t.ttl !== undefined && t.ttl !== 255 ? ` ttl ${t.ttl}` : ' ttl inherit';
    return `${t.name}: gre/ip  remote ${t.remote}  local ${t.local}${keyStr}${ttlStr}`;
  }).join('\n');
}

// ─── ip rule ────────────────────────────────────────────────────────

const IP_RULE_HELP = `Usage: ip rule { add | del } SELECTOR ACTION
       ip rule { show | list }
SELECTOR := [ from PREFIX ] [ to PREFIX ] [ priority PRIORITY ]
ACTION := table TABLE_ID`;

const TABLE_NAMES: Record<number, string> = { 255: 'local', 254: 'main', 253: 'default' };

function ipRule(ctx: IpNetworkContext, args: string[]): string {
  if (args.length === 0 || args[0] === 'show' || args[0] === 'list') return ipRuleShow(ctx);
  if (args[0] === 'add') return ipRuleAdd(ctx, args.slice(1));
  if (args[0] === 'del' || args[0] === 'delete') return ipRuleDel(ctx, args.slice(1));
  if (args[0] === 'help') return IP_RULE_HELP;
  return `Command "${args[0]}" is unknown, try "ip rule help".`;
}

function ipRuleAdd(ctx: IpNetworkContext, args: string[]): string {
  const rule = ctx.rule;
  if (!rule) return 'RTNETLINK answers: Operation not supported';

  let from: string | undefined;
  let to: string | undefined;
  let priority: number | undefined;
  let table: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'from' && args[i + 1]) from = args[++i];
    else if (args[i] === 'to' && args[i + 1]) to = args[++i];
    else if ((args[i] === 'priority' || args[i] === 'pref') && args[i + 1]) priority = parseInt(args[++i], 10);
    else if (args[i] === 'table' && args[i + 1]) table = parseInt(args[++i], 10);
  }

  if (table === undefined || isNaN(table)) return 'Error: "table" is required, try "ip rule help".';
  const finalPriority = priority !== undefined && !isNaN(priority) ? priority : 32764;

  return rule.addRule({ priority: finalPriority, from, to, table });
}

function ipRuleDel(ctx: IpNetworkContext, args: string[]): string {
  const rule = ctx.rule;
  if (!rule) return 'RTNETLINK answers: Operation not supported';

  const priorityIdx = args.indexOf('priority') !== -1 ? args.indexOf('priority') : args.indexOf('pref');
  const priority = priorityIdx !== -1 && args[priorityIdx + 1] ? parseInt(args[priorityIdx + 1], 10) : NaN;
  if (isNaN(priority)) return 'Usage: ip rule del priority PRIORITY';

  return rule.removeRule(priority);
}

function ipRuleShow(ctx: IpNetworkContext): string {
  const rule = ctx.rule;
  if (!rule) return '';
  return rule.listRules().map(r => {
    const from = r.from ? `from ${r.from}` : 'from all';
    const to = r.to ? ` to ${r.to}` : '';
    const tableName = TABLE_NAMES[r.table] ?? String(r.table);
    return `${r.priority}:\t${from}${to} lookup ${tableName}`;
  }).join('\n');
}

// ─── ip netns ───────────────────────────────────────────────────────

const IP_NETNS_HELP = `Usage: ip netns list
       ip netns add NAME
       ip netns delete NAME
       ip netns exec NAME cmd ...`;

function ipNetns(ctx: IpNetworkContext, args: string[]): string {
  const netns = ctx.netns;
  if (!netns) return 'RTNETLINK answers: Operation not supported';

  if (args.length === 0 || args[0] === 'list' || args[0] === 'show') {
    return netns.list().join('\n');
  }
  if (args[0] === 'add') {
    const name = args[1];
    if (!name) return 'Usage: ip netns add NAME';
    return netns.add(name);
  }
  if (args[0] === 'del' || args[0] === 'delete') {
    const name = args[1];
    if (!name) return 'Usage: ip netns delete NAME';
    return netns.remove(name);
  }
  if (args[0] === 'exec') {
    return 'Error: "ip netns exec" requires the async ip command wrapper.';
  }
  if (args[0] === 'help') return IP_NETNS_HELP;
  return `Command "${args[0]}" is unknown, try "ip netns help".`;
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
