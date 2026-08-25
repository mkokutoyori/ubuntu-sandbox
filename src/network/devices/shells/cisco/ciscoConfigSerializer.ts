import type { RoutingConfigRepository } from '../../inspection/config/RoutingConfigRepository';
import { renderRedistribute } from '../../inspection/config/RoutingConfigRepository';
import type { PolicyRepository } from '../../inspection/config/PolicyRepository';

const BLOCK_ORDER: ReadonlyArray<{ rank: number; test: RegExp }> = [
  { rank: 0, test: /^version\b/ },
  { rank: 1, test: /^(no )?service\b/ },
  { rank: 2, test: /^hostname\b/ },
  { rank: 3, test: /^boot\b/ },
  { rank: 4, test: /^enable (secret|password)\b/ },
  { rank: 5, test: /^aaa\b/ },
  { rank: 6, test: /^clock\b/ },
  { rank: 7, test: /^ip (domain-name|domain name|name-server)\b/ },
  /**
   * Les vues AVANT les comptes, et ce demi-rang n'est pas cosmetique :
   * `username X view NOC` refuse une vue inconnue — la bonne regle, elle
   * empeche d'attacher un role jamais decrit. `parser view` n'etait
   * classee nulle part, donc elle tombait au rang des non-classees
   * (19.5), c'est-a-dire APRES les comptes : la configuration que la
   * machine produisait ne pouvait pas etre relue par elle-meme, et
   * l'import d'une topologie perdait la vue du compte sans rien dire.
   */
  { rank: 7.5, test: /^parser view\b/ },
  { rank: 8, test: /^username\b/ },
  /**
   * Une regle `privilege` n'etait classee NULLE PART : elle tombait au
   * rang des non-classees (19,5), c'est-a-dire a une place que rien n'a
   * choisie, entre les listes d'acces et les route-maps. Elle decrit qui
   * a le droit de faire quoi, comme `enable secret`, `aaa`, `parser
   * view` et `username` — que les captures montrent toutes dans le bloc
   * de tete, avant les interfaces — et la documentation Cisco enchaine
   * partout `username …` puis `privilege exec level …`.
   *
   * Le `privilege level N` d'une LIGNE ne passe pas ici : il est
   * indente, donc il appartient au bloc de sa ligne.
   */
  { rank: 8.5, test: /^privilege\b/ },
  { rank: 9, test: /^key chain\b/ },
  { rank: 10, test: /^ip dhcp\b/ },
  { rank: 11, test: /^(no )?ip (cef|routing|source-route|subnet-zero)\b/ },
  { rank: 12, test: /^crypto\b/ },
  { rank: 13, test: /^track\b/ },
  { rank: 14, test: /^interface\b/ },
  { rank: 15, test: /^router\b/ },
  { rank: 16, test: /^ip route\b/ },
  { rank: 17, test: /^ip nat\b/ },
  { rank: 18, test: /^ip sla\b/ },
  { rank: 18.5, test: /^object-group\b/ },
  { rank: 19, test: /^(ip )?access-list\b/ },
  { rank: 19, test: /^ip prefix-list\b/ },
  /**
   * `snmp-server` passe AVANT `route-map`, et les deux etaient invertis.
   * Mesure sur du texte capture (`ciscoconfparse`,
   * `tests/fixtures/configs/sample_01.ios` et `sample_08.ios`), deux
   * fois independamment : `access-list` … `snmp-server community` …
   * `route-map` … `control-plane` … `line con 0`.
   */
  { rank: 20, test: /^snmp-server\b/ },
  { rank: 21, test: /^route-map\b/ },
  { rank: 22, test: /^banner\b/ },
  { rank: 23, test: /^line\b/ },
  { rank: 24, test: /^ntp\b/ },
  { rank: 25, test: /^event manager\b/ },
];

const UNRANKED = 19.5;

/** Les commandes qui font entrer dans un sous-mode de configuration. */
const MODE_BLOCK = /^(interface|router|line|vlan|archive|event manager applet|route-map|class-map|policy-map|ip sla \d)\b/;

const NEVER_SERIALIZED: ReadonlyArray<RegExp> = [
  /^crypto key (generate|zeroize)\b/,
  /^service dhcp$/,
  /^ip cef$/,
];

export interface ConfigBlock {
  head: string;
  lines: string[];
}

export function splitConfigBlocks(lines: readonly string[]): ConfigBlock[] {
  const blocks: ConfigBlock[] = [];
  let current: ConfigBlock | null = null;
  for (const line of lines) {
    if (line === '!' || line.trim() === '') {
      current = null;
      continue;
    }
    if (/^\s/.test(line)) {
      if (current) current.lines.push(line);
      continue;
    }
    current = { head: line, lines: [line] };
    blocks.push(current);
  }
  return blocks;
}

function rankOf(head: string): number {
  for (const entry of BLOCK_ORDER) if (entry.test.test(head)) return entry.rank;
  return UNRANKED;
}

export function orderCiscoConfigBlocks(body: readonly string[]): string[] {
  const blocks = splitConfigBlocks(body)
    .filter((block) => !NEVER_SERIALIZED.some((pattern) => pattern.test(block.head)));

  const ranked = blocks.map((block, index) => ({ block, index, rank: rankOf(block.head) }));
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);

  const out: string[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const entry = ranked[i];
    out.push(...entry.block.lines);
    // Un `!` par BLOC mettait un séparateur après chaque `ip route`, alors
    // qu'IOS groupe les commandes globales d'une même famille sous un seul.
    // Ce n'était pas qu'un défaut d'affichage : `| section ip route`
    // recopiait fidèlement ces `!`, et on les lui a reprochés à tort.
    // Un bloc à plusieurs lignes (un `interface`, un `router`) garde le
    // sien, puisque c'est lui qui ferme le bloc.
    const next = ranked[i + 1];
    // Un bloc qui OUVRE un mode garde toujours son séparateur, même
    // vide : IOS écrit `!` entre deux `interface` consécutives, et un
    // Catalyst dont les interfaces ne portent rien n'en avait aucun —
    // la règle « suite de commandes globales » les avait collées.
    const singleLine = entry.block.lines.length === 1 && !MODE_BLOCK.test(entry.block.head);
    const runContinues = singleLine && next
      && next.rank === entry.rank && next.block.lines.length === 1
      && !MODE_BLOCK.test(next.block.head);
    if (!runContinues) out.push('!');
  }
  return out;
}

export interface OspfConfigView {
  processId: number;
  routerId?: string;
  networks: ReadonlyArray<{ network: string; wildcard: string; areaId: string }>;
  /**
   * Les interfaces passives, que le processus OSPF connaissait et que la
   * configuration ne rendait pas — EIGRP et RIP les rendent tous deux
   * juste au-dessus. Ce n'est pas un manque d'affichage : la
   * configuration relue est ce qui REFAIT le processus à l'import d'une
   * topologie, donc une interface passive s'y perdait silencieusement et
   * se remettait à émettre des Hellos.
   */
  passiveInterfaces?: ReadonlyArray<string>;
}

export function policyConfigLines(policy: PolicyRepository): string[] {
  const lines: string[] = [];
  for (const v6 of [false, true]) {
    for (const [name, entries] of policy.allPrefixLists(v6)) {
      for (const e of entries) {
        lines.push(`ip${v6 ? 'v6' : ''} prefix-list ${name} seq ${e.seq} ${e.action} ${e.prefix}`
          + `${e.ge !== undefined ? ` ge ${e.ge}` : ''}`
          + `${e.le !== undefined ? ` le ${e.le}` : ''}`);
      }
      lines.push('!');
    }
  }
  for (const [name, clauses] of policy.allRouteMaps()) {
    for (const c of clauses) {
      lines.push(`route-map ${name} ${c.action} ${c.seq}`);
      if (c.description) lines.push(` description ${c.description}`);
      for (const m of c.match) lines.push(` match ${m}`);
      for (const s of c.set) lines.push(` set ${s}`);
      lines.push('!');
    }
  }
  return lines;
}

export function routingProcessConfigLines(
  repo: RoutingConfigRepository, ospf?: OspfConfigView | null,
): string[] {
  const lines: string[] = [];

  for (const process of repo.allEigrp()) {
    lines.push(`router eigrp ${process.asn}`);
    if (process.routerId) lines.push(` eigrp router-id ${process.routerId}`);
    for (const network of process.networks) lines.push(` network ${network}`);
    for (const iface of [...process.passive].sort()) lines.push(` passive-interface ${iface}`);
    for (const source of process.redistribute) lines.push(` redistribute ${renderRedistribute(source)}`);
    for (const extra of process.extras) lines.push(` ${extra}`);
    if (process.variance !== undefined) lines.push(` variance ${process.variance}`);
    if (process.maximumPaths !== undefined) lines.push(` maximum-paths ${process.maximumPaths}`);
    if (process.maximumHops !== undefined) {
      lines.push(` metric maximum-hops ${process.maximumHops}`);
    }
    if (process.stub) lines.push(` eigrp stub ${process.stub}`);

    if (!process.autoSummary) lines.push(' no auto-summary');
    lines.push('!');
  }

  const rip = repo.rip;
  if (rip.networks.length > 0 || rip.version !== null
    || rip.redistribute.length > 0 || rip.extras.length > 0) {
    lines.push('router rip');
    if (rip.version !== null) lines.push(` version ${rip.version}`);
    for (const network of rip.networks) lines.push(` network ${network}`);
    for (const iface of [...rip.passive].sort()) lines.push(` passive-interface ${iface}`);
    for (const neighbor of rip.neighbors) lines.push(` neighbor ${neighbor}`);
    for (const source of rip.redistribute) lines.push(` redistribute ${renderRedistribute(source)}`);
    for (const extra of rip.extras) lines.push(` ${extra}`);
    if (rip.defaultInfoOriginate) lines.push(' default-information originate');
    if (!rip.autoSummary) lines.push(' no auto-summary');
    lines.push('!');
  }

  const bgp = repo.getBgp();
  if (bgp) {
    lines.push(`router bgp ${bgp.asn}`);
    if (bgp.routerId) lines.push(` bgp router-id ${bgp.routerId}`);
    if (!bgp.defaultIpv4Unicast) lines.push(' no bgp default ipv4-unicast');
    for (const [name, group] of [...bgp.peerGroups.entries()].sort()) {
      lines.push(` neighbor ${name} peer-group`);
      if (group.remoteAs !== undefined) lines.push(` neighbor ${name} remote-as ${group.remoteAs}`);
      if (group.description) lines.push(` neighbor ${name} description ${group.description}`);
    }
    for (const [ip, neighbor] of [...bgp.neighbors.entries()].sort()) {
      if (neighbor.remoteAs !== undefined) {
        lines.push(` neighbor ${ip} remote-as ${neighbor.remoteAs}`);
      }
      if (neighbor.peerGroup) lines.push(` neighbor ${ip} peer-group ${neighbor.peerGroup}`);
      if (neighbor.description) lines.push(` neighbor ${ip} description ${neighbor.description}`);
      if (neighbor.updateSource) {
        lines.push(` neighbor ${ip} update-source ${neighbor.updateSource}`);
      }
      // Everything else the operator set on this neighbour, as typed.
      // These were collected into `attrs` and then rendered by nobody, so
      // next-hop-self, password, prefix-list, soft-reconfiguration and the
      // rest vanished from the configuration that had just accepted them.
      for (const attr of neighbor.attrs) lines.push(` ${attr}`);
    }
    for (const network of bgp.networks) lines.push(` network ${network}`);
    for (const source of bgp.redistribute) lines.push(` redistribute ${renderRedistribute(source)}`);
    for (const extra of bgp.extras) lines.push(` ${extra}`);
    lines.push('!');
  }

  if (ospf) {
    lines.push(`router ospf ${ospf.processId}`);
    if (ospf.routerId && ospf.routerId !== '0.0.0.0') lines.push(` router-id ${ospf.routerId}`);
    for (const n of ospf.networks) lines.push(` network ${n.network} ${n.wildcard} area ${n.areaId}`);
    for (const iface of [...(ospf.passiveInterfaces ?? [])].sort()) {
      lines.push(` passive-interface ${iface}`);
    }
    lines.push('!');
  }

  return lines;
}

export function renderStartupConfig(snapshot: string, nvramBytes: number): string {
  const body = snapshot
    .split('\n')
    .filter((line) => !/^Building configuration/.test(line)
      && !/^Current configuration\b/.test(line))
    .join('\n')
    .replace(/^\n+/, '');
  const used = new TextEncoder().encode(body).length + 1;
  return [`Using ${used} out of ${nvramBytes} bytes`, '!', body].join('\n');
}
