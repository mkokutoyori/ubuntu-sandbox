import { renderTable, FIXED_TABLE } from '../cli/TextTable';
import type { EIGRPEngine } from '../../../eigrp/EIGRPEngine';
import type { EigrpStubTlv } from '../../../eigrp/packets';

interface NeighborRow {
  h: number;
  address: string;
  iface: string;
  hold: number;
  uptimeSec: number;
  srtt: number;
  rto: number;
  seq: number;
}

const NEIGHBOR_COLUMNS = [
  { header: 'H', width: 4, value: (r: NeighborRow) => String(r.h) },
  { header: 'Address', width: 24, value: (r: NeighborRow) => r.address },
  { header: 'Interface', width: 23, value: (r: NeighborRow) => r.iface },
  { header: 'Hold', width: 5, value: (r: NeighborRow) => String(r.hold).padStart(4) },
  { header: 'Uptime', width: 9, value: (r: NeighborRow) => iosUptime(r.uptimeSec) },
  { header: 'SRTT', width: 7, value: (r: NeighborRow) => String(r.srtt).padStart(4) },
  { header: 'RTO', width: 5, value: (r: NeighborRow) => String(r.rto).padStart(3) },
  { header: 'Q', width: 3, value: () => '0' },
  { header: 'Seq', value: (r: NeighborRow) => String(r.seq) },
] as const;

function placeAt(labels: ReadonlyArray<readonly [number, string]>): string {
  let out = '';
  for (const [col, text] of labels) {
    out = out.padEnd(col) + text;
  }
  return out;
}

const NEIGHBOR_UNITS_ROW = placeAt([[51, '(sec)'], [65, '(ms)'], [76, 'Cnt'], [80, 'Num']]);

export function iosUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:`
      + String(s % 60).padStart(2, '0');
  }
  const j = Math.floor(s / 86400);
  if (j < 7) return `${j}d${String(Math.floor((s % 86400) / 3600)).padStart(2, '0')}h`;
  return `${Math.floor(j / 7)}w${j % 7}d`;
}

function neighborRows(e: EIGRPEngine): NeighborRow[] {
  const views = e.getNeighbors();
  const details = new Map(e.getNeighborDetails().map((d) => [`${d.ip}%${d.iface}`, d]));
  return views.map((v, i) => ({
    h: i,
    address: v.address,
    iface: v.iface,
    hold: details.get(`${v.address}%${v.iface}`)?.holdTimeSec ?? 15,
    uptimeSec: v.uptimeSec,
    srtt: 1,
    rto: 100,
    seq: i + 1,
  }));
}

function neighborHeader(asn: number): string[] {
  return [`EIGRP-IPv4 Neighbors for AS(${asn})`];
}

export function showIpEigrpNeighbors(e: EIGRPEngine): string {
  const rows = neighborRows(e);
  const table = renderTable(rows, NEIGHBOR_COLUMNS, FIXED_TABLE);
  return [
    ...neighborHeader(e.getConfig().asn),
    table[0], NEIGHBOR_UNITS_ROW, ...table.slice(1),
  ].join('\n');
}

function stubTlvOptions(s: EigrpStubTlv): string {
  const words: string[] = [];
  if (s.connected) words.push('CONNECTED');
  if (s.staticRoutes) words.push('STATIC');
  if (s.summary) words.push('SUMMARY');
  if (s.redistributed) words.push('REDISTRIBUTED');
  if (s.receiveOnly) words.push('RECEIVE-ONLY');
  return words.join(' ');
}

export function showIpEigrpNeighborsDetail(e: EIGRPEngine): string {
  const rows = neighborRows(e);
  const details = new Map(e.getNeighborDetails().map((d) => [`${d.ip}%${d.iface}`, d]));
  const table = renderTable(rows, NEIGHBOR_COLUMNS, FIXED_TABLE);
  const out = [
    ...neighborHeader(e.getConfig().asn),
    table[0], NEIGHBOR_UNITS_ROW,
  ];
  rows.forEach((r, i) => {
    out.push(table[i + 1]);
    const d = details.get(`${r.address}%${r.iface}`);
    out.push('   Version 4.0/3.0, Retrans: 0, Retries: 0, Prefixes: '
      + String(e.getTopologyTable().size));
    out.push('   Topology-ids from peer - 0');
    if (d?.stub) {
      out.push(`   Stub Peer Advertising ( ${stubTlvOptions(d.stub)} ) Routes`);
      out.push('   Suppressing queries');
    }
  });
  return out.join('\n');
}


interface InterfaceRow {
  iface: string;
  peers: number;
  helloSec: number;
  holdSec: number;
  authMode: 'md5' | 'none';
  keyChain?: string;
  mcastSent: number;
  ucastSent: number;
  helloSent: number;
  updateSent: number;
}

const INTERFACE_COLUMNS = [
  { header: '', width: 23, value: (r: InterfaceRow) => r.iface },
  { header: '', width: 9, value: (r: InterfaceRow) => String(r.peers) },
  { header: '', width: 10, value: () => '0/0' },
  { header: '', width: 13, value: () => '0/0' },
  { header: '', width: 9, value: () => '0' },
  { header: '', width: 13, value: () => '0/1' },
  { header: '', width: 14, value: () => '0' },
  { header: '', value: () => '0' },
] as const;

const INTERFACE_HEADER_1 =
  '                              Xmit Queue   PeerQ        Mean   Pacing Time   Multicast    Pending';
const INTERFACE_HEADER_2 =
  'Interface              Peers  Un/Reliable  Un/Reliable  SRTT   Un/Reliable   Flow Timer   Routes';

function interfaceRows(e: EIGRPEngine): InterfaceRow[] {
  return e.getInterfaceStates().map((s) => {
    const t = e.getInterfaceTraffic(s.iface);
    return { ...s, ...t };
  });
}

export function showIpEigrpInterfaces(e: EIGRPEngine, detail = false,
  only?: string): string {
  let rows = interfaceRows(e);
  if (only) {
    rows = rows.filter((r) => r.iface.toLowerCase() === only.toLowerCase());
  }
  const table = renderTable(rows, INTERFACE_COLUMNS, FIXED_TABLE);
  const out = [
    `EIGRP-IPv4 Interfaces for AS(${e.getConfig().asn})`,
    INTERFACE_HEADER_1, INTERFACE_HEADER_2,
  ];
  rows.forEach((r, i) => {
    out.push(table[i + 1]);
    if (!detail) return;
    out.push(`  Hello-interval is ${r.helloSec}, Hold-time is ${r.holdSec}`);
    out.push('  Split-horizon is enabled');
    out.push('  Next xmit serial <none>');
    out.push(`  Packetized sent/expedited: ${r.updateSent}/0`);
    out.push(`  Hello's sent/expedited: ${r.helloSent}/0`);
    out.push(`  Un/reliable mcasts: 0/${r.mcastSent}  Un/reliable ucasts: 0/${r.ucastSent}`);
    out.push('  Mcast exceptions: 0  CR packets: 0  ACKs suppressed: 0');
    out.push('  Retransmissions sent: 0  Out-of-sequence rcvd: 0');
    out.push('  Topology-ids on interface - 0');
    out.push(r.authMode === 'md5'
      ? `  Authentication mode is md5,  key-chain is "${r.keyChain ?? ''}"`
      : '  Authentication mode is not set');
    out.push('  Topologies advertised on this interface:  base');
    out.push('  Topologies not advertised on this interface:');
    out.push('');
  });
  return out.join('\n');
}


const TOPOLOGY_CODES = [
  'Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,',
  '       r - reply Status, s - sia Status',
  '',
];

export function showIpEigrpTopology(e: EIGRPEngine, allLinks = false): string {
  const c = e.getConfig();
  const lines = [
    `EIGRP-IPv4 Topology Table for AS(${c.asn})/ID(${e.effectiveRouterId()})`,
    ...TOPOLOGY_CODES,
  ];
  for (const pre of e.originatedPrefixes()) {
    const fd = connectedMetric(pre.bandwidthKbps, pre.delayUsec);
    lines.push(`P ${pre.network}/${pre.mask.toCIDR()}, 1 successors, FD is ${fd}`);
    lines.push(pre.external
      ? '        via Redistributed'
      : `        via Connected, ${pre.iface ?? ''}`.trimEnd());
  }
  for (const [prefix, entry] of e.getTopologyTable()) {
    const total = 1 + entry.feasibleSuccessors.length;
    lines.push(`P ${prefix}, ${total} successors, FD is ${entry.fd}`);
    lines.push(`        via ${entry.successorNextHop} (${entry.fd}/`
      + `${entry.successorRd}), ${entry.successorIface}`);
    for (const fs of entry.feasibleSuccessors) {
      lines.push(`        via ${fs.nextHop} (${fs.metric}/${fs.rd}), ${fs.iface}`);
    }
    if (allLinks) {
      for (const other of entry.rejectedPaths) {
        lines.push(`        via ${other.nextHop} (${other.metric}/${other.rd}), `
          + `${other.iface}`);
      }
    }
  }
  return lines.join('\n');
}

function connectedMetric(bwKbps = 0, delayUsec = 0): number {
  const bw = bwKbps > 0 ? Math.floor(10000000 / bwKbps) : 0;
  return (bw + Math.floor(delayUsec / 10)) * 256;
}


export interface EigrpProtocolHost {
  _getPortsInternal(): ReadonlyMap<string, unknown>;
}

export interface EigrpProtocolProcess {
  asn: number;
  routerId?: string;
  networks: string[];
  passive: Set<string>;
  passiveDefault?: boolean;
  redistribute: Array<{ protocol: string }>;
  maximumHops?: number;
  autoSummary: boolean;
  stub?: string;
}

export function eigrpProtocolBlock(
  p: EigrpProtocolProcess, e: EIGRPEngine, host: EigrpProtocolHost,
): string[] {
  const c = e.getConfig();
  const k = c.kValues;
  const out = [
    `Routing Protocol is "eigrp ${p.asn}"`,
    '  Outgoing update filter list for all interfaces is not set',
    '  Incoming update filter list for all interfaces is not set',
    '  Default networks flagged in outgoing updates',
    '  Default networks accepted from incoming updates',
    `  EIGRP-IPv4 Protocol for AS(${p.asn})`,
    `    Metric weight K1=${k.k1}, K2=${k.k2}, K3=${k.k3}, K4=${k.k4}, K5=${k.k5}`,
    '    NSF-aware route hold timer is 240',
  ];
  if (p.routerId) out.push(`    EIGRP Router-ID: ${p.routerId}`);
  const stub = e.getStub();
  if (stub) {
    out.push('    EIGRP stub-router feature is enabled');
    out.push(`      Stub Options: ${stubConfigOptions(stub)}`);
  }
  out.push('    Topology : 0 (base)');
  out.push('      Active Timer: 3 min');
  out.push('      Distance: internal 90 external 170');
  out.push(`      Maximum path: ${c.maximumPaths}`);
  out.push(`      Maximum hopcount ${p.maximumHops ?? 100}`);
  out.push(`      EIGRP maximum metric variance ${c.variance}`);
  for (const r of p.redistribute) out.push(`  Redistributing: ${r.protocol}`);
  out.push(`  Automatic summarization: ${p.autoSummary ? 'enabled' : 'disabled'}`);
  const resumes = configuredSummaries(host);
  if (resumes.length) {
    out.push('  Address Summarization:');
    for (const r of resumes) out.push(`    ${r}`);
  }
  out.push(`  Maximum path: ${c.maximumPaths}`);
  out.push('  Routing for Networks:');
  for (const n of p.networks) out.push(`    ${n}`);
  const passives = [...p.passive].sort();
  if (p.passiveDefault || passives.length) {
    out.push('  Passive Interface(s):');
    if (p.passiveDefault) out.push('    Default');
    for (const i of passives) out.push(`    ${i}`);
  }
  if (p.passiveDefault) {
    const actives = [...host._getPortsInternal().keys()]
      .filter((n) => !p.passive.has(n)).sort();
    if (actives.length) {
      out.push('  Active Interface(s):');
      for (const i of actives) out.push(`    ${i}`);
    }
  }
  out.push('  Routing Information Sources:');
  out.push('    Gateway         Distance      Last Update');
  for (const n of e.getNeighbors()) {
    out.push(`    ${n.address.padEnd(16)}${String(90).padStart(4)}`
      + `      ${iosUptime(n.uptimeSec)}`);
  }
  out.push('  Distance: internal 90 external 170');
  return out;
}

function stubConfigOptions(s: {
  connected: boolean; summary: boolean; staticRoutes: boolean;
  redistributed: boolean; receiveOnly: boolean;
}): string {
  const words: string[] = [];
  if (s.receiveOnly) words.push('Receive-Only');
  if (s.connected) words.push('Connected');
  if (s.staticRoutes) words.push('Static');
  if (s.summary) words.push('Summary');
  if (s.redistributed) words.push('Redistributed');
  return words.join(', ');
}

function configuredSummaries(host: EigrpProtocolHost): string[] {
  const out: string[] = [];
  for (const [name, raw] of host._getPortsInternal()) {
    const port = raw as { eigrpSummaries?: string[] };
    for (const line of port.eigrpSummaries ?? []) {
      const words = line.trim().split(/\s+/);
      const network = words[3];
      const mask = words[4];
      if (!network || !mask) continue;
      out.push(`${network}/${cidrFromMask(mask)} for ${name}`);
    }
  }
  return out;
}

function cidrFromMask(mask: string): number {
  return mask.split('.')
    .reduce((n, o) => n + ((Number(o) >>> 0).toString(2).match(/1/g)?.length ?? 0), 0);
}
