/**
 * Les vues EIGRP d'IOS, rendues d'après des sorties RÉELLES.
 *
 * Les largeurs de colonnes viennent de captures (`ntc-templates`,
 * jeux `show_ip_eigrp_neighbors` et `show_ip_eigrp_interfaces_detail`),
 * pas d'un exemple de documentation dont le HTML écrase les blancs —
 * c'est-à-dire l'information cherchée. Le défaut qu'elles ferment est
 * mesuré : la table des voisins collait le nom d'interface au temps de
 * garde (`GigabitEthernet0/013`), et la vue des interfaces ne rendait
 * que son en-tête, jamais une ligne.
 *
 * Deux lignes d'en-tête sont écrites telles quelles plutôt que
 * déclarées : sur la vraie machine, l'en-tête et les données de
 * `show ip eigrp interfaces` ne sont PAS alignés (les valeurs partent
 * deux caractères après leur intitulé), donc les déduire l'un de
 * l'autre reproduirait un alignement que le produit réel n'a pas. Elles
 * ne portent aucune donnée, il n'y a donc rien qui puisse dériver.
 */
import { renderTable, FIXED_TABLE } from '../cli/TextTable';
import type { EIGRPEngine } from '../../../eigrp/EIGRPEngine';
import type { EigrpStubTlv } from '../../../eigrp/packets';

interface RangeeVoisin {
  h: number;
  address: string;
  iface: string;
  hold: number;
  uptimeSec: number;
  srtt: number;
  rto: number;
  seq: number;
}

const COLONNES_VOISINS = [
  { header: 'H', width: 4, value: (r: RangeeVoisin) => String(r.h) },
  { header: 'Address', width: 24, value: (r: RangeeVoisin) => r.address },
  { header: 'Interface', width: 23, value: (r: RangeeVoisin) => r.iface },
  { header: 'Hold', width: 5, value: (r: RangeeVoisin) => String(r.hold).padStart(4) },
  { header: 'Uptime', width: 9, value: (r: RangeeVoisin) => dureeIos(r.uptimeSec) },
  { header: 'SRTT', width: 7, value: (r: RangeeVoisin) => String(r.srtt).padStart(4) },
  { header: 'RTO', width: 5, value: (r: RangeeVoisin) => String(r.rto).padStart(3) },
  { header: 'Q', width: 3, value: () => '0' },
  { header: 'Seq', value: (r: RangeeVoisin) => String(r.seq) },
] as const;

/** La seconde ligne d'en-tête, aux abscisses de la capture. */
function poser(labels: ReadonlyArray<readonly [number, string]>): string {
  let out = '';
  for (const [col, texte] of labels) {
    out = out.padEnd(col) + texte;
  }
  return out;
}

const UNITES_VOISINS = poser([[51, '(sec)'], [65, '(ms)'], [76, 'Cnt'], [80, 'Num']]);

export function dureeIos(sec: number): string {
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

function rangeesVoisins(e: EIGRPEngine): RangeeVoisin[] {
  const vues = e.getNeighbors();
  const details = new Map(e.getNeighborDetails().map((d) => [`${d.ip}%${d.iface}`, d]));
  return vues.map((v, i) => ({
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

function enTeteVoisins(asn: number): string[] {
  return [`EIGRP-IPv4 Neighbors for AS(${asn})`];
}

export function showIpEigrpNeighbors(e: EIGRPEngine): string {
  const rangees = rangeesVoisins(e);
  const table = renderTable(rangees, COLONNES_VOISINS, FIXED_TABLE);
  return [
    ...enTeteVoisins(e.getConfig().asn),
    table[0], UNITES_VOISINS, ...table.slice(1),
  ].join('\n');
}

/** `( CONNECTED SUMMARY )` — ce que le pair a réellement annoncé. */
function optionsStub(s: EigrpStubTlv): string {
  const mots: string[] = [];
  if (s.connected) mots.push('CONNECTED');
  if (s.staticRoutes) mots.push('STATIC');
  if (s.summary) mots.push('SUMMARY');
  if (s.redistributed) mots.push('REDISTRIBUTED');
  if (s.receiveOnly) mots.push('RECEIVE-ONLY');
  return mots.join(' ');
}

export function showIpEigrpNeighborsDetail(e: EIGRPEngine): string {
  const rangees = rangeesVoisins(e);
  const details = new Map(e.getNeighborDetails().map((d) => [`${d.ip}%${d.iface}`, d]));
  const table = renderTable(rangees, COLONNES_VOISINS, FIXED_TABLE);
  const out = [
    ...enTeteVoisins(e.getConfig().asn),
    table[0], UNITES_VOISINS,
  ];
  rangees.forEach((r, i) => {
    out.push(table[i + 1]);
    const d = details.get(`${r.address}%${r.iface}`);
    out.push('   Version 4.0/3.0, Retrans: 0, Retries: 0, Prefixes: '
      + String(e.getTopologyTable().size));
    out.push('   Topology-ids from peer - 0');
    if (d?.stub) {
      out.push(`   Stub Peer Advertising ( ${optionsStub(d.stub)} ) Routes`);
      out.push('   Suppressing queries');
    }
  });
  return out.join('\n');
}


interface RangeeInterface {
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

const COLONNES_INTERFACES = [
  { header: '', width: 23, value: (r: RangeeInterface) => r.iface },
  { header: '', width: 9, value: (r: RangeeInterface) => String(r.peers) },
  { header: '', width: 10, value: () => '0/0' },
  { header: '', width: 13, value: () => '0/0' },
  { header: '', width: 9, value: () => '0' },
  { header: '', width: 13, value: () => '0/1' },
  { header: '', width: 14, value: () => '0' },
  { header: '', value: () => '0' },
] as const;

const ENTETE_INTERFACES_1 =
  '                              Xmit Queue   PeerQ        Mean   Pacing Time   Multicast    Pending';
const ENTETE_INTERFACES_2 =
  'Interface              Peers  Un/Reliable  Un/Reliable  SRTT   Un/Reliable   Flow Timer   Routes';

function rangeesInterfaces(e: EIGRPEngine): RangeeInterface[] {
  return e.getInterfaceStates().map((s) => {
    const t = e.getInterfaceTraffic(s.iface);
    return { ...s, ...t };
  });
}

export function showIpEigrpInterfaces(e: EIGRPEngine, detail = false,
  seulement?: string): string {
  let rangees = rangeesInterfaces(e);
  if (seulement) {
    rangees = rangees.filter((r) => r.iface.toLowerCase() === seulement.toLowerCase());
  }
  const table = renderTable(rangees, COLONNES_INTERFACES, FIXED_TABLE);
  const out = [
    `EIGRP-IPv4 Interfaces for AS(${e.getConfig().asn})`,
    ENTETE_INTERFACES_1, ENTETE_INTERFACES_2,
  ];
  rangees.forEach((r, i) => {
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


const CODES_TOPOLOGIE = [
  'Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,',
  '       r - reply Status, s - sia Status',
  '',
];

export function showIpEigrpTopology(e: EIGRPEngine, allLinks = false): string {
  const c = e.getConfig();
  const lignes = [
    `EIGRP-IPv4 Topology Table for AS(${c.asn})/ID(${e.effectiveRouterId()})`,
    ...CODES_TOPOLOGIE,
  ];
  for (const pre of e.originatedPrefixes()) {
    const fd = metriqueConnectee(pre.bandwidthKbps, pre.delayUsec);
    lignes.push(`P ${pre.network}/${pre.mask.toCIDR()}, 1 successors, FD is ${fd}`);
    lignes.push(pre.external
      ? '        via Redistributed'
      : `        via Connected, ${pre.iface ?? ''}`.trimEnd());
  }
  for (const [prefixe, entree] of e.getTopologyTable()) {
    const total = 1 + entree.feasibleSuccessors.length;
    lignes.push(`P ${prefixe}, ${total} successors, FD is ${entree.fd}`);
    lignes.push(`        via ${entree.successorNextHop} (${entree.fd}/`
      + `${entree.successorRd}), ${entree.successorIface}`);
    for (const fs of entree.feasibleSuccessors) {
      lignes.push(`        via ${fs.nextHop} (${fs.metric}/${fs.rd}), ${fs.iface}`);
    }
    if (allLinks) {
      for (const autre of entree.rejectedPaths) {
        lignes.push(`        via ${autre.nextHop} (${autre.metric}/${autre.rd}), `
          + `${autre.iface}`);
      }
    }
  }
  return lignes.join('\n');
}

function metriqueConnectee(bwKbps = 0, delayUsec = 0): number {
  const bw = bwKbps > 0 ? Math.floor(10000000 / bwKbps) : 0;
  return (bw + Math.floor(delayUsec / 10)) * 256;
}


/** Ce que `show ip protocols` a besoin de lire sur le routeur. */
export interface EigrpProtocolHost {
  _getPortsInternal(): ReadonlyMap<string, unknown>;
}

/** Le processus tel que la configuration le décrit. */
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
  p: EigrpProtocolProcess, e: EIGRPEngine, hote: EigrpProtocolHost,
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
    out.push(`      Stub Options: ${optionsStubConfig(stub)}`);
  }
  out.push('    Topology : 0 (base)');
  out.push('      Active Timer: 3 min');
  out.push('      Distance: internal 90 external 170');
  out.push(`      Maximum path: ${c.maximumPaths}`);
  out.push(`      Maximum hopcount ${p.maximumHops ?? 100}`);
  out.push(`      EIGRP maximum metric variance ${c.variance}`);
  for (const r of p.redistribute) out.push(`  Redistributing: ${r.protocol}`);
  out.push(`  Automatic summarization: ${p.autoSummary ? 'enabled' : 'disabled'}`);
  const resumes = resumesConfigures(hote);
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
    const actives = [...hote._getPortsInternal().keys()]
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
      + `      ${dureeIos(n.uptimeSec)}`);
  }
  out.push('  Distance: internal 90 external 170');
  return out;
}

function optionsStubConfig(s: {
  connected: boolean; summary: boolean; staticRoutes: boolean;
  redistributed: boolean; receiveOnly: boolean;
}): string {
  const mots: string[] = [];
  if (s.receiveOnly) mots.push('Receive-Only');
  if (s.connected) mots.push('Connected');
  if (s.staticRoutes) mots.push('Static');
  if (s.summary) mots.push('Summary');
  if (s.redistributed) mots.push('Redistributed');
  return mots.join(', ');
}

/** `ip summary-address eigrp <as> <prefixe> <masque>` posés sur les ports. */
function resumesConfigures(hote: EigrpProtocolHost): string[] {
  const out: string[] = [];
  for (const [nom, brut] of hote._getPortsInternal()) {
    const port = brut as { eigrpSummaries?: string[] };
    for (const ligne of port.eigrpSummaries ?? []) {
      const mots = ligne.trim().split(/\s+/);
      const reseau = mots[3];
      const masque = mots[4];
      if (!reseau || !masque) continue;
      out.push(`${reseau}/${cidrDeMasque(masque)} for ${nom}`);
    }
  }
  return out;
}

function cidrDeMasque(masque: string): number {
  return masque.split('.')
    .reduce((n, o) => n + ((Number(o) >>> 0).toString(2).match(/1/g)?.length ?? 0), 0);
}
