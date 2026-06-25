/**
 * LinuxNetCommands — ifconfig, netstat, ss, curl, wget.
 *
 * Provides realistic output matching Ubuntu/Debian conventions.
 * Network info comes from the IpNetworkContext when available.
 */

import type { IpInterfaceInfo, IpNetworkContext } from './LinuxIpCommand';
import type { SocketTable, SocketEntry, SocketState } from '../../core/SocketTable';
import type { CapturedPacket, PacketCaptureLog } from './network/PacketCaptureLog';
import { broadcastAddress } from '../../core/ip';

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
  numeric: boolean, resolveService?: ServiceResolver,
): string {
  if (!numeric && resolveService && port > 0) {
    const name = resolveService(port, proto);
    if (name) return `${addr}:${name}`;
  }
  return `${addr}:${port}`;
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

export function cmdNetstat(
  args: string[],
  ctx: IpNetworkContext | null,
  isServer: boolean,
  socketTable?: SocketTable | null,
  resolveService?: ServiceResolver,
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
      for (const name of ctx.getInterfaceNames()) {
        const info = ctx.getInterfaceInfo(name);
        if (!info) continue;
        const mtu = String(info.mtu).padStart(7);
        const rx  = String(info.counters.framesIn).padStart(8);
        const tx  = String(info.counters.framesOut).padStart(9);
        const flags = info.isUp ? (info.isConnected ? 'BMRU' : 'BMU') : 'BMU';
        rows.push(`${name.padEnd(11)}${mtu} ${rx}      0      0 0        ${tx}      0      0      0 ${flags}`);
      }
      rows.push(`lo        65536      128      0      0 0           128      0      0      0 LRU`);
    } else {
      rows.push('eth0      1500     1024      0      0 0           512      0      0      0 BMRU');
      rows.push('lo       65536      128      0      0 0           128      0      0      0 LRU');
    }
    return [...header, ...rows].join('\n');
  }

  if (hasFlag('s') || args.includes('--statistics')) {
    return cmdNetstatStatistics(socketTable);
  }

  // Determine which protocols to show (no -t/-u → show both)
  const wantTcp = hasFlag('t');
  const wantUdp = hasFlag('u');
  const showAll = !wantTcp && !wantUdp;

  const showProcesses = hasFlag('p');
  const numeric = hasFlag('n');
  const wantAll = hasFlag('a') || args.includes('--all');
  const wantListening = hasFlag('l') || args.includes('--listening');

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
      if (!socketVisible(sock.state, wantAll, wantListening)) continue;

      const localAddr  = formatEndpoint(sock.localAddress, sock.localPort, sock.protocol, numeric, resolveService);
      const remoteAddr = sock.state === 'LISTEN'
        ? '0.0.0.0:*'
        : formatEndpoint(sock.remoteAddress, sock.remotePort, sock.protocol, numeric, resolveService);
      const stateCol   = isTcp ? sock.state : '';
      const pidCol     = showProcesses && sock.pid ? `${sock.pid}/${sock.processName}` : '';

      lines.push(formatNetstatLine(sock.protocol, localAddr, remoteAddr, stateCol, pidCol));
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

function cmdNetstatStatistics(socketTable?: SocketTable | null): string {
  let tcpListen = 0;
  let tcpEstablished = 0;
  if (socketTable) {
    for (const sock of socketTable.getAll()) {
      if (sock.protocol !== 'tcp') continue;
      if (sock.state === 'LISTEN') tcpListen++;
      else if (sock.state === 'ESTABLISHED') tcpEstablished++;
    }
  }
  return [
    'Ip:',
    '    Forwarding: 2',
    '    0 total packets received',
    '    0 forwarded',
    '    0 incoming packets discarded',
    '    0 incoming packets delivered',
    '    0 requests sent out',
    'Icmp:',
    '    0 ICMP messages received',
    '    0 input ICMP message failed',
    '    ICMP input histogram:',
    '    0 ICMP messages sent',
    '    0 ICMP messages failed',
    '    ICMP output histogram:',
    'Tcp:',
    `    ${tcpEstablished} active connection openings`,
    `    ${tcpListen} passive connection openings`,
    '    0 failed connection attempts',
    '    0 connection resets received',
    `    ${tcpEstablished} connections established`,
    '    0 segments retransmitted',
    'Udp:',
    '    0 packets received',
    '    0 packets to unknown port received',
    '    0 packet receive errors',
    '    0 packets sent',
    '    0 receive buffer errors',
    'TcpExt:',
    'IpExt:',
  ].join('\n');
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

  if (socketTable) {
    for (const sock of socketTable.getAll()) {
      const isTcp = sock.protocol === 'tcp';
      const isUdp = sock.protocol === 'udp';
      if (!showAll && isTcp && !wantTcp) continue;
      if (!showAll && isUdp && !wantUdp) continue;
      if (stateFilter === 'established' || stateFilter === 'connected') {
        if (sock.state !== 'ESTABLISHED') continue;
      } else if (!socketVisible(sock.state, wantAll, wantListening)) {
        continue;
      }

      const localAddr  = formatEndpoint(sock.localAddress, sock.localPort, sock.protocol, numeric, resolveService);
      const remoteAddr = sock.state === 'LISTEN'
        ? '0.0.0.0:*'
        : formatEndpoint(sock.remoteAddress, sock.remotePort, sock.protocol, numeric, resolveService);
      const stateCol   = ssStateLabel(sock);
      const procCol    = showProcesses && sock.pid
        ? ` users:(("${sock.processName}",pid=${sock.pid},fd=3))`
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

// ─── tcpdump ────────────────────────────────────────────────────────

/**
 * `tcpdump` — render captured TCP segments from the device's
 * {@link PacketCaptureLog}. Supports the flags the suite exercises:
 *   -i <iface>   capture interface (descriptive)
 *   -n / -nn     numeric addresses/ports (always numeric in the sim)
 *   -c <count>   stop after `count` packets
 *   port <n>     Berkeley-packet-filter expression on the port
 */
export interface TcpdumpOptions {
  iface: string;
  count: number;
  portFilter: number | null;
}

export function parseTcpdumpArgs(args: string[]): TcpdumpOptions {
  let iface = 'eth0';
  let count = Infinity;
  let portFilter: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'port') { portFilter = Number.parseInt(args[++i], 10) || null; continue; }
    if (!a.startsWith('-')) continue;
    const chars = a.slice(1);
    for (let c = 0; c < chars.length; c++) {
      const ch = chars[c];
      if (ch === 'i' || ch === 'c') {
        const glued = chars.slice(c + 1);
        const value = glued !== '' ? glued : (args[++i] ?? '');
        if (ch === 'i') iface = value || iface;
        else count = Number.parseInt(value, 10) || Infinity;
        break;
      }
    }
  }
  return { iface, count, portFilter };
}

export function tcpdumpHeader(iface: string): string[] {
  return [
    'tcpdump: verbose output suppressed, use -v[v]... for full protocol decode',
    `listening on ${iface}, link-type EN10MB (Ethernet), snapshot length 262144 bytes`,
  ];
}

export function tcpdumpFooter(count: number): string[] {
  return [
    `${count} packet${count === 1 ? '' : 's'} captured`,
    `${count} packet${count === 1 ? '' : 's'} received by filter`,
    '0 packets dropped by kernel',
  ];
}

export function packetMatchesPort(p: CapturedPacket, portFilter: number | null): boolean {
  return portFilter === null || p.srcPort === portFilter || p.dstPort === portFilter;
}

export function cmdTcpdump(args: string[], log: PacketCaptureLog | null): string {
  const { iface, count, portFilter } = parseTcpdumpArgs(args);
  const captured = log ? log.all() : [];
  const matching = captured
    .filter((p) => packetMatchesPort(p, portFilter))
    .slice(0, count === Infinity ? undefined : count);
  const body = matching.map(formatTcpdumpPacket);
  return [...tcpdumpHeader(iface), ...body, ...tcpdumpFooter(matching.length)].join('\n');
}

/** Render one captured segment in tcpdump's default one-line form. */
export function formatTcpdumpPacket(p: CapturedPacket): string {
  const ts = p.at.toTimeString().slice(0, 8) +
    '.' + String(p.at.getMilliseconds()).padStart(3, '0') + '000';
  const win = p.flags === 'S' ? 64240 : p.flags === 'S.' ? 65160 : 502;
  const ackPart = p.flags === 'S' ? '' : `, ack ${p.ack}`;
  return `${ts} IP ${p.srcIp}.${p.srcPort} > ${p.dstIp}.${p.dstPort}: ` +
    `Flags [${p.flags}], seq ${p.seq}${ackPart}, win ${win}, length ${p.length}`;
}

// ─── arping ─────────────────────────────────────────────────────────

/**
 * `arping` — probe a host at the link layer with ARP requests.
 *
 * The simulator has no live ARP responder on this path, so a probe to an
 * unreachable / powered-off target faithfully reports zero responses. The
 * `Sent N probes (N broadcast(s))` summary line matches real `arping`.
 */
export function cmdArping(args: string[]): string {
  let count = 0;
  let target = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c') { count = parseInt(args[++i], 10) || 0; continue; }
    if (a === '-I' || a === '-i' || a === '-s' || a === '-w') { i++; continue; }
    if (!a.startsWith('-')) target = a;
  }
  if (!target) {
    return 'Usage: arping [-fqbDUAV] [-c count] [-w timeout] [-I device] destination';
  }
  const probes = count > 0 ? count : 1;
  return [
    `ARPING ${target}`,
    `Sent ${probes} probes (${probes} broadcast(s))`,
    `Received 0 response(s)`,
  ].join('\n');
}

// ─── curl ───────────────────────────────────────────────────────────

export function cmdCurl(args: string[]): string {
  const verbose = args.includes('-v') || args.includes('--verbose');
  const head = args.includes('-I') || args.includes('--head');
  const silent = args.includes('-s') || args.includes('--silent');
  const url = args.filter(a => !a.startsWith('-')).pop();

  if (!url) return 'curl: try \'curl --help\' for more information';

  // Simulated responses for common URLs
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    if (head) {
      return [
        'HTTP/1.1 200 OK',
        'Date: ' + new Date().toUTCString(),
        'Server: Oracle-Application-Server-11g',
        'Content-Length: 0',
        'Content-Type: text/html; charset=UTF-8',
        '',
      ].join('\n');
    }
    return '<html><body><h1>It works!</h1></body></html>';
  }

  // External URLs: simulated connection error (no real network)
  if (verbose) {
    return [
      `*   Trying ${url}...`,
      '* connect to host failed',
      `* Failed to connect to ${url} port 80: Connection refused`,
      `curl: (7) Failed to connect to ${url} port 80 after 0 ms: Connection refused`,
    ].join('\n');
  }

  return `curl: (6) Could not resolve host: ${url.replace(/https?:\/\//, '').split('/')[0]}`;
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
