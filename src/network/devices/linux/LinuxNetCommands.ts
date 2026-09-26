/**
 * LinuxNetCommands — ifconfig, netstat, ss, curl, wget.
 *
 * Provides realistic output matching Ubuntu/Debian conventions.
 * Network info comes from the IpNetworkContext when available.
 */

import type { IpInterfaceInfo, IpNetworkContext } from './LinuxIpCommand';
import type { SocketTable, SocketEntry, SocketState } from '../../core/SocketTable';
import { broadcastAddress, tryIpToUint32, prefixLengthToMaskUint32 } from '../../core/ip';
import { snmpSnapshot, type SnmpSnapshot } from './ports/PortsFilesystem';
import type { ProtocolCounters } from '../../layers/internet/ProtocolCounters';

export type ServiceResolver = (port: number, proto: string) => string | null;

const SS_TCP_STATE: Record<SocketState, string> = {
  LISTEN: 'LISTEN', ESTABLISHED: 'ESTAB', SYN_SENT: 'SYN-SENT', SYN_RECEIVED: 'SYN-RECV',
  FIN_WAIT_1: 'FIN-WAIT-1', FIN_WAIT_2: 'FIN-WAIT-2', CLOSE_WAIT: 'CLOSE-WAIT',
  CLOSING: 'CLOSING', LAST_ACK: 'LAST-ACK', TIME_WAIT: 'TIME-WAIT', CLOSED: 'UNCONN',
};

function ssStateLabel(sock: SocketEntry): string {
  if (sock.protocol === 'udp') return sock.state === 'ESTABLISHED' ? 'ESTAB' : 'UNCONN';
  return SS_TCP_STATE[sock.state] ?? sock.state;
}

function socketVisible(state: SocketState, wantAll: boolean, wantListening: boolean): boolean {
  if (wantListening) return state === 'LISTEN';
  if (wantAll) return true;
  return state !== 'LISTEN';
}

function formatEndpoint(
  addr: string, port: number, proto: string,
  numeric: boolean, resolveService?: ServiceResolver, bracketV6 = false,
): string {
  const host = bracketV6 && addr.includes(':') ? `[${addr}]` : addr;
  if (!numeric && resolveService && port > 0) {
    const name = resolveService(port, proto);
    if (name) return `${host}:${name}`;
  }
  return `${host}:${port}`;
}

export type PortResolver = (name: string) => number | null;

type PortCompare = (a: number, b: number) => boolean;
const SS_FILTER_OPS: Record<string, PortCompare> = {
  '=': (a, b) => a === b, '==': (a, b) => a === b, eq: (a, b) => a === b,
  '!=': (a, b) => a !== b, ne: (a, b) => a !== b,
  '>': (a, b) => a > b, gt: (a, b) => a > b,
  '<': (a, b) => a < b, lt: (a, b) => a < b,
  '>=': (a, b) => a >= b, ge: (a, b) => a >= b,
  '<=': (a, b) => a <= b, le: (a, b) => a <= b,
};

interface PortPredicate { side: 'sport' | 'dport'; cmp: PortCompare; port: number; }

function parsePortValue(token: string, resolvePort?: PortResolver): number | null {
  let v = token.startsWith(':') ? token.slice(1) : token;
  if (v.includes(':')) v = v.slice(v.lastIndexOf(':') + 1);
  if (v === '' || v === '*') return null;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return resolvePort?.(v) ?? null;
}

function parsePortFilters(args: string[], resolvePort?: PortResolver): PortPredicate[] {
  const out: PortPredicate[] = [];
  for (let i = 0; i < args.length; i++) {
    const side = args[i];
    if (side !== 'sport' && side !== 'dport') continue;
    let op = '=';
    let valueToken = args[i + 1];
    if (valueToken && SS_FILTER_OPS[valueToken]) { op = valueToken; valueToken = args[i + 2]; i += 2; }
    else { i += 1; }
    if (!valueToken) continue;
    const port = parsePortValue(valueToken, resolvePort);
    if (port === null) continue;
    out.push({ side, cmp: SS_FILTER_OPS[op], port });
  }
  return out;
}

function matchesPortFilters(sock: SocketEntry, filters: PortPredicate[]): boolean {
  for (const f of filters) {
    const p = f.side === 'sport' ? sock.localPort : sock.remotePort;
    if (!f.cmp(p, f.port)) return false;
  }
  return true;
}

interface CidrRange { network: number; mask: number }
interface AddrSpec { addr: string | null; port: number | null; cidr?: CidrRange }
interface AddrPredicate extends AddrSpec { side: 'src' | 'dst' }

function parseAddrSpec(token: string, resolvePort?: PortResolver): AddrSpec {
  const slash = token.indexOf('/');
  if (slash !== -1) {
    const net = tryIpToUint32(token.slice(0, slash));
    const prefix = parseInt(token.slice(slash + 1), 10);
    if (net !== null && Number.isFinite(prefix) && prefix >= 0 && prefix <= 32) {
      const mask = prefixLengthToMaskUint32(prefix);
      return { addr: null, port: null, cidr: { network: net & mask, mask } };
    }
  }
  let m = /^\[(.+)\]:(.+)$/.exec(token);
  if (m) return { addr: m[1], port: parsePortValue(m[2], resolvePort) };
  if (token.startsWith(':')) return { addr: null, port: parsePortValue(token, resolvePort) };
  m = /^(\d{1,3}(?:\.\d{1,3}){3}):(.+)$/.exec(token);
  if (m) return { addr: m[1], port: parsePortValue(m[2], resolvePort) };
  return { addr: token === '*' ? null : token, port: null };
}

function parseAddrFilters(args: string[], resolvePort?: PortResolver): AddrPredicate[] {
  const out: AddrPredicate[] = [];
  for (let i = 0; i < args.length; i++) {
    const side = args[i];
    if (side !== 'src' && side !== 'dst') continue;
    let valueToken = args[i + 1];
    if (valueToken === '=' || (valueToken && SS_FILTER_OPS[valueToken])) { valueToken = args[i + 2]; i += 2; }
    else { i += 1; }
    if (!valueToken) continue;
    out.push({ side, ...parseAddrSpec(valueToken, resolvePort) });
  }
  return out;
}

function matchesAddrFilters(sock: SocketEntry, filters: AddrPredicate[]): boolean {
  for (const f of filters) {
    const addr = f.side === 'src' ? sock.localAddress : sock.remoteAddress;
    const port = f.side === 'src' ? sock.localPort : sock.remotePort;
    if (f.cidr) {
      const a = tryIpToUint32(addr);
      if (a === null || (a & f.cidr.mask) >>> 0 !== (f.cidr.network >>> 0)) return false;
    } else if (f.addr !== null && addr !== f.addr) {
      return false;
    }
    if (f.port !== null && port !== f.port) return false;
  }
  return true;
}

function familyVisible(addr: string, want4: boolean, want6: boolean): boolean {
  if (want4 === want6) return true;
  return addr.includes(':') ? want6 : want4;
}

// ─── ifconfig ───────────────────────────────────────────────────────

const IFF_UP = 0x1;
const IFF_BROADCAST = 0x2;
const IFF_LOOPBACK = 0x8;
const IFF_RUNNING = 0x40;
const IFF_MULTICAST = 0x1000;

export function cmdIfconfig(args: string[], ctx: IpNetworkContext | null): string {
  const showAll = args.includes('-a');
  const positional = args.filter(a => !a.startsWith('-'));
  const interfaces = buildInterfaces(ctx);
  const target = positional[0];

  if (target) {
    const iface = interfaces.find(i => i.name === target);
    if (!iface) return `${target}: error fetching interface information: Device not found`;
    return formatIfconfigInterface(iface);
  }

  return interfaces
    .filter(i => showAll || i.isUp)
    .map(formatIfconfigInterface)
    .join('\n\n');
}

function loopbackInterface(): IpInterfaceInfo {
  return {
    name: 'lo', mac: '00:00:00:00:00:00',
    ip: '127.0.0.1', mask: '255.0.0.0', cidr: 8,
    mtu: 65536, isUp: true, isConnected: true, isDHCP: false,
    counters: { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 },
    ipv6: [{ address: '::1', prefixLength: 128, scope: 'host' }],
  };
}

function buildInterfaces(ctx: IpNetworkContext | null): IpInterfaceInfo[] {
  const ifaces: IpInterfaceInfo[] = [loopbackInterface()];
  if (!ctx) return ifaces;
  for (const name of ctx.getInterfaceNames()) {
    if (name === 'lo') continue; // already added
    const info = ctx.getInterfaceInfo(name);
    if (info) ifaces.push(info);
  }
  return ifaces;
}

function interfaceFlags(i: IpInterfaceInfo): { value: number; names: string[] } {
  const isLoopback = i.name === 'lo';
  let value = 0;
  const names: string[] = [];
  if (i.isUp) { value |= IFF_UP; names.push('UP'); }
  if (isLoopback) {
    value |= IFF_LOOPBACK; names.push('LOOPBACK');
  } else {
    value |= IFF_BROADCAST; names.push('BROADCAST');
  }
  if (i.isUp && i.isConnected) { value |= IFF_RUNNING; names.push('RUNNING'); }
  if (!isLoopback) { value |= IFF_MULTICAST; names.push('MULTICAST'); }
  return { value, names };
}

export function formatIfconfigInterface(i: IpInterfaceInfo): string {
  const isLoopback = i.name === 'lo';
  const flags = interfaceFlags(i);
  const c = i.counters;
  const lines = [
    `${i.name}: flags=${flags.value}<${flags.names.join(',')}>  mtu ${i.mtu}`,
  ];

  if (i.ip) {
    const mask = i.mask ?? '255.255.255.0';
    const brd = i.cidr !== null ? broadcastAddress(i.ip, i.cidr) : null;
    const brdStr = !isLoopback && brd ? `  broadcast ${brd}` : '';
    lines.push(`        inet ${i.ip}  netmask ${mask}${brdStr}`);
  }

  for (const v6 of i.ipv6 ?? []) {
    const scopeId = v6.scope === 'link' ? '0x20<link>'
      : v6.scope === 'host' ? '0x10<host>' : '0x0<global>';
    lines.push(`        inet6 ${v6.address}  prefixlen ${v6.prefixLength}  scopeid ${scopeId}`);
  }

  lines.push(isLoopback
    ? `        loop  txqueuelen 1000  (Local Loopback)`
    : `        ether ${i.mac}  txqueuelen 1000  (Ethernet)`);
  lines.push(`        RX packets ${c.framesIn}  bytes ${c.bytesIn} (${(c.bytesIn / 1024).toFixed(1)} KiB)`);
  lines.push(`        RX errors 0  dropped 0  overruns 0  frame 0`);
  lines.push(`        TX packets ${c.framesOut}  bytes ${c.bytesOut} (${(c.bytesOut / 1024).toFixed(1)} KiB)`);
  lines.push(`        TX errors 0  dropped 0  overruns 0  carrier 0  collisions 0`);
  return lines.join('\n');
}

// ─── netstat ────────────────────────────────────────────────────────

export type PidResolver = (processName: string) => number | undefined;

function ownerPid(
  sock: { pid?: number; processName?: string }, resolvePid?: PidResolver,
): number | undefined {
  if (sock.pid) return sock.pid;
  return sock.processName ? resolvePid?.(sock.processName) : undefined;
}

export function cmdNetstat(
  args: string[],
  ctx: IpNetworkContext | null,
  isServer: boolean,
  socketTable?: SocketTable | null,
  resolveService?: ServiceResolver,
  resolvePid?: PidResolver,
  counters?: ProtocolCounters,
): string {
  // Expand combined flags: '-tlnp' → individual chars t,l,n,p
  const hasFlag = (ch: string): boolean =>
    args.some(a => a.startsWith('-') && !a.startsWith('--') && a.includes(ch)) ||
    args.includes(`--${ch}`);

  const routing = hasFlag('r') || args.includes('--route');
  const ifaces  = hasFlag('i') || args.includes('--interfaces');

  if (routing) {
    const header = [
      'Kernel IP routing table',
      'Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface',
    ];
    const rows: string[] = [];
    if (ctx) {
      for (const r of ctx.getRoutingTable()) {
        const dest = r.type === 'default' ? '0.0.0.0' : r.network;
        const gw   = r.nextHop ?? '0.0.0.0';
        const mask = cidrToMask(r.cidr);
        const flags = (r.type === 'default' || r.nextHop) ? 'UG' : 'U';
        rows.push(
          `${dest.padEnd(16)}${gw.padEnd(16)}${mask.padEnd(16)}${flags.padEnd(8)}0 0          0 ${r.iface}`,
        );
      }
      rows.push('127.0.0.0       0.0.0.0         255.0.0.0       U         0 0          0 lo');
    } else {
      rows.push('0.0.0.0         10.0.0.1        0.0.0.0         UG        0 0          0 eth0');
      rows.push('10.0.0.0        0.0.0.0         255.255.255.0   U         0 0          0 eth0');
      rows.push('127.0.0.0       0.0.0.0         255.0.0.0       U         0 0          0 lo');
    }
    return [...header, ...rows].join('\n');
  }

  if (ifaces) {
    const header = [
      'Kernel Interface table',
      'Iface      MTU    RX-OK RX-ERR RX-DRP RX-OVR    TX-OK TX-ERR TX-DRP TX-OVR Flg',
    ];
    const rows: string[] = [];
    if (ctx) {
      const noms = ctx.getInterfaceNames();
      for (const name of noms.includes('lo') ? noms : [...noms, 'lo']) {
        const info = ctx.getInterfaceInfo(name);
        if (!info) continue;
        const mtu = String(info.mtu).padStart(7);
        const rx  = String(info.counters.framesIn).padStart(8);
        const tx  = String(info.counters.framesOut).padStart(9);
        const flags = name === 'lo'
          ? 'LRU'
          : (info.isUp && info.isConnected ? 'BMRU' : 'BMU');
        rows.push(`${name.padEnd(11)}${mtu} ${rx}      0      0 0        ${tx}      0      0      0 ${flags}`);
      }
    } else {
      rows.push('eth0      1500     1024      0      0 0           512      0      0      0 BMRU');
      rows.push('lo       65536      128      0      0 0           128      0      0      0 LRU');
    }
    return [...header, ...rows].join('\n');
  }

  if (hasFlag('s') || args.includes('--statistics')) {
    return cmdNetstatStatistics(snmpSnapshot(socketTable, counters));
  }

  // Determine which protocols to show (no -t/-u → show both)
  const wantTcp = hasFlag('t');
  const wantUdp = hasFlag('u');
  const showAll = !wantTcp && !wantUdp;

  const showProcesses = hasFlag('p');
  const numeric = hasFlag('n');
  const wantAll = hasFlag('a') || args.includes('--all');
  const wantListening = hasFlag('l') || args.includes('--listening');
  const want4 = hasFlag('4') || args.includes('--ipv4');
  const want6 = hasFlag('6') || args.includes('--ipv6');

  const banner = wantListening
    ? 'Active Internet connections (only servers)'
    : wantAll
      ? 'Active Internet connections (servers and established)'
      : 'Active Internet connections (w/o servers)';
  const lines = [
    banner,
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
  ];

  if (socketTable) {
    for (const sock of socketTable.getAll()) {
      const isTcp = sock.protocol === 'tcp';
      const isUdp = sock.protocol === 'udp';
      if (!showAll && isTcp && !wantTcp) continue;
      if (!showAll && isUdp && !wantUdp) continue;
      if (!familyVisible(sock.localAddress, want4, want6)) continue;
      if (!socketVisible(sock.state, wantAll, wantListening)) continue;

      const v6 = sock.localAddress.includes(':');
      const localAddr  = formatEndpoint(sock.localAddress, sock.localPort, sock.protocol, numeric, resolveService);
      const remoteAddr = sock.state === 'LISTEN'
        ? (v6 ? ':::*' : '0.0.0.0:*')
        : formatEndpoint(sock.remoteAddress, sock.remotePort, sock.protocol, numeric, resolveService);
      const stateCol   = isTcp ? sock.state : '';
      const pid        = ownerPid(sock, resolvePid);
      const pidCol     = showProcesses && pid ? `${pid}/${sock.processName}` : '';

      lines.push(formatNetstatLine(`${sock.protocol}${v6 ? '6' : ''}`, localAddr, remoteAddr, stateCol, pidCol));
    }
  } else {
    // Fallback when no socket table is wired (e.g. in test environments that
    // construct LinuxCommandExecutor directly without a device).
    if (wantTcp || showAll) {
      lines.push(formatNetstatLine('tcp', '0.0.0.0:22', '0.0.0.0:*', 'LISTEN', '985/sshd: /usr/sbin'));
      if (isServer) {
        lines.push(formatNetstatLine('tcp', '0.0.0.0:1521', '0.0.0.0:*', 'LISTEN', '2001/tnslsnr'));
      }
    }
    if (wantUdp || showAll) {
      lines.push(formatNetstatLine('udp', '127.0.0.53:53', '0.0.0.0:*', '', '540/systemd-resolve'));
    }
  }

  return lines.join('\n');
}

function cmdNetstatStatistics(snapshot: SnmpSnapshot): string {
  const c = snapshot.counters;
  return [
    'Ip:',
    '    Forwarding: 2',
    `    ${c.ipInReceives} total packets received`,
    `    ${c.ipForwDatagrams} forwarded`,
    `    ${c.ipInDiscards} incoming packets discarded`,
    `    ${c.ipInDelivers} incoming packets delivered`,
    `    ${c.ipOutRequests} requests sent out`,
    ...(c.ipOutNoRoutes > 0 ? [`    ${c.ipOutNoRoutes} dropped because of missing route`] : []),
    'Icmp:',
    `    ${c.icmpInMsgs} ICMP messages received`,
    `    ${c.icmpInErrors} input ICMP message failed`,
    '    ICMP input histogram:',
    ...icmpHistogram({
      'destination unreachable': c.icmpInDestUnreachs,
      'timeout in transit': c.icmpInTimeExcds,
      redirects: c.icmpInRedirects,
      'echo requests': c.icmpInEchos,
      'echo replies': c.icmpInEchoReps,
    }),
    `    ${c.icmpOutMsgs} ICMP messages sent`,
    `    ${c.icmpOutErrors} ICMP messages failed`,
    '    ICMP output histogram:',
    ...icmpHistogram({
      'destination unreachable': c.icmpOutDestUnreachs,
      'time exceeded': c.icmpOutTimeExcds,
      redirects: c.icmpOutRedirects,
      'echo requests': c.icmpOutEchos,
      'echo replies': c.icmpOutEchoReps,
    }),
    'Tcp:',
    `    ${c.tcpActiveOpens} active connection openings`,
    `    ${c.tcpPassiveOpens} passive connection openings`,
    `    ${c.tcpAttemptFails} failed connection attempts`,
    `    ${c.tcpEstabResets} connection resets received`,
    `    ${snapshot.currEstab} connections established`,
    `    ${c.tcpInSegs} segments received`,
    `    ${c.tcpOutSegs} segments sent out`,
    `    ${c.tcpRetransSegs} segments retransmitted`,
    'Udp:',
    `    ${c.udpInDatagrams} packets received`,
    `    ${c.udpNoPorts} packets to unknown port received`,
    `    ${c.udpInErrors} packet receive errors`,
    `    ${c.udpOutDatagrams} packets sent`,
    '    0 receive buffer errors',
    'TcpExt:',
    'IpExt:',
  ].join('\n');
}

function icmpHistogram(lignes: Record<string, number>): string[] {
  return Object.entries(lignes)
    .filter(([, n]) => n > 0)
    .map(([nom, n]) => `        ${nom}: ${n}`);
}

function formatNetstatLine(
  proto: string,
  local: string,
  remote: string,
  state: string,
  pid: string,
): string {
  const p   = proto.padEnd(10);
  const rq  = '0'.padStart(6);
  const sq  = '0'.padStart(6);
  const loc = local.padEnd(23);
  const rem = remote.padEnd(23);
  const st  = state.padEnd(11);
  return `${p} ${rq} ${sq} ${loc} ${rem} ${st} ${pid}`.trimEnd();
}

// ─── ss ─────────────────────────────────────────────────────────────

export function cmdSs(
  args: string[], isServer: boolean,
  socketTable?: SocketTable | null, resolveService?: ServiceResolver,
  resolvePort?: PortResolver, resolvePid?: PidResolver,
): string {
  // Expand combined flags: '-tlnp' → individual chars t,l,n,p
  const hasFlag = (ch: string): boolean =>
    args.some(a => a.startsWith('-') && !a.startsWith('--') && a.includes(ch)) ||
    args.includes(`--${ch}`);

  // `ss ... state <name>` — filter by TCP state (established, listening, …).
  const stateIdx = args.indexOf('state');
  const stateFilter = stateIdx >= 0 ? (args[stateIdx + 1] ?? '').toLowerCase() : null;

  const wantListening = hasFlag('l') || args.includes('--listening')
    || stateFilter === 'listening' || stateFilter === 'listen';
  const wantTcp       = hasFlag('t') || args.includes('--tcp');
  const wantUdp       = hasFlag('u') || args.includes('--udp');
  const showProcesses = hasFlag('p') || args.includes('--processes');
  const summary       = args.includes('-s') || args.includes('--summary');
  const numeric       = hasFlag('n') || args.includes('--numeric');
  const wantAll       = hasFlag('a') || args.includes('--all');
  const want4         = hasFlag('4') || args.includes('--ipv4');
  const want6         = hasFlag('6') || args.includes('--ipv6');
  const showAll       = !wantTcp && !wantUdp; // no proto filter → show both

  if (summary) {
    // Real `ss -s`: counters derived from the live socket table — the
    // canned figures below only survive as the degraded no-table path.
    if (socketTable) {
      const all = socketTable.getAll();
      const tcp = all.filter(s => s.protocol === 'tcp');
      const udp = all.filter(s => s.protocol === 'udp');
      const estab = tcp.filter(s => s.state === 'ESTABLISHED').length;
      const closed = tcp.filter(s => s.state === 'CLOSED').length;
      const timewait = tcp.filter(s => s.state === 'TIME_WAIT').length;
      const inet = tcp.length + udp.length;
      const row = (name: string, total: number, ip: number): string =>
        `${name.padEnd(10)}${String(total).padEnd(10)}` +
        `${String(ip).padEnd(10)}0`;
      return [
        `Total: ${all.length}`,
        `TCP:   ${tcp.length} (estab ${estab}, closed ${closed}, ` +
          `orphaned 0, timewait ${timewait})`,
        '',
        'Transport Total     IP        IPv6',
        row('RAW', 0, 0),
        row('UDP', udp.length, udp.length),
        row('TCP', tcp.length, tcp.length),
        row('INET', inet, inet),
        row('FRAG', 0, 0),
      ].join('\n');
    }
    return [
      'Total: 120',
      'TCP:   8 (estab 2, closed 0, orphaned 0, timewait 0)',
      '',
      'Transport Total     IP        IPv6',
      'RAW       1         0         1',
      'UDP       4         3         1',
      'TCP       8         6         2',
      'INET      13        9         4',
      'FRAG      0         0         0',
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push('State      Recv-Q  Send-Q   Local Address:Port     Peer Address:Port  Process');

  const portFilters = parsePortFilters(args, resolvePort);
  const addrFilters = parseAddrFilters(args, resolvePort);

  if (socketTable) {
    for (const sock of socketTable.getAll()) {
      const isTcp = sock.protocol === 'tcp';
      const isUdp = sock.protocol === 'udp';
      if (!showAll && isTcp && !wantTcp) continue;
      if (!showAll && isUdp && !wantUdp) continue;
      if (!familyVisible(sock.localAddress, want4, want6)) continue;
      if (stateFilter === 'established' || stateFilter === 'connected') {
        if (sock.state !== 'ESTABLISHED') continue;
      } else if (!socketVisible(sock.state, wantAll, wantListening)) {
        continue;
      }
      if (!matchesPortFilters(sock, portFilters)) continue;
      if (!matchesAddrFilters(sock, addrFilters)) continue;

      const v6 = sock.localAddress.includes(':');
      const localAddr  = formatEndpoint(sock.localAddress, sock.localPort, sock.protocol, numeric, resolveService, true);
      const remoteAddr = sock.state === 'LISTEN'
        ? (v6 ? '[::]:*' : '0.0.0.0:*')
        : formatEndpoint(sock.remoteAddress, sock.remotePort, sock.protocol, numeric, resolveService, true);
      const stateCol   = ssStateLabel(sock);
      const pid        = ownerPid(sock, resolvePid);
      const procCol    = showProcesses && pid
        ? ` users:(("${sock.processName}",pid=${pid},fd=3))`
        : '';

      lines.push(`${stateCol.padEnd(10)} 0       0        ${localAddr.padEnd(22)} ${remoteAddr.padEnd(18)}${procCol}`);
    }
  } else {
    // Fallback (no socket table)
    if (wantListening || wantTcp || showAll) {
      const proc = showProcesses ? ' users:(("sshd",pid=985,fd=3))' : '';
      lines.push(`LISTEN     0       128      0.0.0.0:22            0.0.0.0:*        ${proc}`);
      if (isServer) {
        const sp = showProcesses ? ' users:(("tnslsnr",pid=2001,fd=12))' : '';
        lines.push(`LISTEN     0       128      0.0.0.0:1521          0.0.0.0:*        ${sp}`);
      }
    }
    if (!wantListening) {
      const proc = showProcesses ? ' users:(("sshd",pid=1200,fd=4))' : '';
      lines.push(`ESTAB      0       0        127.0.0.1:22          127.0.0.1:54322  ${proc}`);
    }
  }

  return lines.join('\n');
}

// ─── wget ───────────────────────────────────────────────────────────

export function cmdWget(args: string[]): string {
  const quiet = args.includes('-q') || args.includes('--quiet');
  const url = args.filter(a => !a.startsWith('-')).pop();

  if (!url) return 'wget: missing URL\nUsage: wget [OPTION]... [URL]...';

  const host = url.replace(/https?:\/\//, '').split('/')[0];

  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    const filename = url.split('/').pop() || 'index.html';
    if (quiet) return '';
    return [
      `--${new Date().toISOString().replace('T', ' ').slice(0, 19)}--  ${url}`,
      `Resolving ${host}... 127.0.0.1`,
      `Connecting to ${host}|127.0.0.1|:80... connected.`,
      'HTTP request sent, awaiting response... 200 OK',
      'Length: 1024 (1.0K) [text/html]',
      `Saving to: '${filename}'`,
      '',
      `${filename}              100%[===================>]   1.00K  --.-KB/s    in 0s`,
      '',
      `${new Date().toISOString().replace('T', ' ').slice(0, 19)} (10.0 MB/s) - '${filename}' saved [1024/1024]`,
    ].join('\n');
  }

  // Une adresse littérale n'a rien à résoudre : le vrai `wget` passe
  // directement à « Connecting to ». Annoncer un échec de résolution sur
  // `wget http://192.168.10.1` envoyait l'opérateur inspecter son DNS
  // alors que le nom n'était jamais en cause (audit 11, §3).
  const litterale = /^\[?[0-9a-fA-F:.]+\]?(:\d+)?$/.test(host)
    && (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host) || host.includes(':'));
  if (litterale) {
    const nu = host.replace(/^\[|\]$/g, '').split(/]?:(?=\d+$)/)[0];
    if (quiet) return '';
    return [
      `--${new Date().toISOString().replace('T', ' ').slice(0, 19)}--  ${url}`,
      `Connecting to ${nu}:80... failed: Connection refused.`,
    ].join('\n');
  }

  return [
    `--${new Date().toISOString().replace('T', ' ').slice(0, 19)}--  ${url}`,
    `Resolving ${host}... failed: Temporary failure in name resolution.`,
    `wget: unable to resolve host address '${host}'`,
  ].join('\n');
}

function cidrToMask(cidr: number): string {
  if (cidr <= 0) return '0.0.0.0';
  if (cidr >= 32) return '255.255.255.255';
  const mask = (~0 << (32 - cidr)) >>> 0;
  return [(mask >>> 24) & 0xff, (mask >>> 16) & 0xff, (mask >>> 8) & 0xff, mask & 0xff].join('.');
}
