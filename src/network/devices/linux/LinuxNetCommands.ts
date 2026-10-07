/**
 * LinuxNetCommands — ifconfig, the netstat tables, wget.
 *
 * Provides realistic output matching Ubuntu/Debian conventions.
 * Network info comes from the IpNetworkContext when available.
 */

import { simulationDate } from '@/network/core/SystemClock';

import type { IpInterfaceInfo, IpNetworkContext } from './LinuxIpCommand';
import { broadcastAddress } from '../../core/ip';
import { linuxSnmpSnapshot, type LinuxSnmpSnapshot } from './ports/PortsFilesystem';
import type { KernelIpFacts } from './LinuxIpv4Settings';
import type { ProtocolCounters } from '../../layers/internet/ProtocolCounters';

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

export function renderNetstatRoutes(ctx: IpNetworkContext | null): string {
  const lines = [
    'Kernel IP routing table',
    'Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface',
  ];
  if (ctx === null) return lines.join('\n');
  for (const r of ctx.getRoutingTable()) {
    const dest = r.type === 'default' ? '0.0.0.0' : r.network;
    const gw   = r.nextHop ?? '0.0.0.0';
    const mask = cidrToMask(r.cidr);
    const flags = (r.type === 'default' || r.nextHop) ? 'UG' : 'U';
    lines.push(`${dest.padEnd(16)}${gw.padEnd(16)}${mask.padEnd(16)}${flags.padEnd(8)}0 0          0 ${r.iface}`);
  }
  lines.push('127.0.0.0       0.0.0.0         255.0.0.0       U         0 0          0 lo');
  return lines.join('\n');
}

export function renderNetstatInterfaces(ctx: IpNetworkContext | null): string {
  const lines = [
    'Kernel Interface table',
    'Iface      MTU    RX-OK RX-ERR RX-DRP RX-OVR    TX-OK TX-ERR TX-DRP TX-OVR Flg',
  ];
  if (ctx === null) return lines.join('\n');
  const names = ctx.getInterfaceNames();
  for (const name of names.includes('lo') ? names : [...names, 'lo']) {
    const info = ctx.getInterfaceInfo(name);
    if (!info) continue;
    const mtu = String(info.mtu).padStart(7);
    const rx  = String(info.counters.framesIn).padStart(8);
    const tx  = String(info.counters.framesOut).padStart(9);
    const flags = name === 'lo'
      ? 'LRU'
      : (info.isUp && info.isConnected ? 'BMRU' : 'BMU');
    lines.push(`${name.padEnd(11)}${mtu} ${rx}      0      0 0        ${tx}      0      0      0 ${flags}`);
  }
  return lines.join('\n');
}

export function renderNetstatStatistics(counters?: ProtocolCounters, kernel?: KernelIpFacts): string {
  return cmdNetstatStatistics(linuxSnmpSnapshot(counters, kernel));
}

function cmdNetstatStatistics(snapshot: LinuxSnmpSnapshot): string {
  const c = snapshot.counters;
  return [
    'Ip:',
    `    Forwarding: ${snapshot.kernel.forwarding ? 1 : 2}`,
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
      `--${simulationDate().toISOString().replace('T', ' ').slice(0, 19)}--  ${url}`,
      `Resolving ${host}... 127.0.0.1`,
      `Connecting to ${host}|127.0.0.1|:80... connected.`,
      'HTTP request sent, awaiting response... 200 OK',
      'Length: 1024 (1.0K) [text/html]',
      `Saving to: '${filename}'`,
      '',
      `${filename}              100%[===================>]   1.00K  --.-KB/s    in 0s`,
      '',
      `${simulationDate().toISOString().replace('T', ' ').slice(0, 19)} (10.0 MB/s) - '${filename}' saved [1024/1024]`,
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
      `--${simulationDate().toISOString().replace('T', ' ').slice(0, 19)}--  ${url}`,
      `Connecting to ${nu}:80... failed: Connection refused.`,
    ].join('\n');
  }

  return [
    `--${simulationDate().toISOString().replace('T', ' ').slice(0, 19)}--  ${url}`,
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
