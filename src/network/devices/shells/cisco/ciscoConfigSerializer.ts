import type { RoutingConfigRepository } from '../../inspection/config/RoutingConfigRepository';

const BLOCK_ORDER: ReadonlyArray<{ rank: number; test: RegExp }> = [
  { rank: 0, test: /^version\b/ },
  { rank: 1, test: /^(no )?service\b/ },
  { rank: 2, test: /^hostname\b/ },
  { rank: 3, test: /^boot\b/ },
  { rank: 4, test: /^enable (secret|password)\b/ },
  { rank: 5, test: /^aaa\b/ },
  { rank: 6, test: /^clock\b/ },
  { rank: 7, test: /^ip (domain-name|domain name|name-server)\b/ },
  { rank: 8, test: /^username\b/ },
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
  { rank: 19, test: /^(ip )?access-list\b/ },
  { rank: 19, test: /^ip prefix-list\b/ },
  { rank: 20, test: /^route-map\b/ },
  { rank: 21, test: /^snmp-server\b/ },
  { rank: 22, test: /^banner\b/ },
  { rank: 23, test: /^line\b/ },
  { rank: 24, test: /^ntp\b/ },
  { rank: 25, test: /^event manager\b/ },
];

const UNRANKED = 19.5;

const NEVER_SERIALIZED: ReadonlyArray<RegExp> = [
  /^crypto key (generate|zeroize)\b/,
  /^service dhcp$/,
  /^ip routing$/,
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
  for (const entry of ranked) {
    out.push(...entry.block.lines);
    out.push('!');
  }
  return out;
}

export function routingProcessConfigLines(repo: RoutingConfigRepository): string[] {
  const lines: string[] = [];

  for (const process of repo.allEigrp()) {
    lines.push(`router eigrp ${process.asn}`);
    if (process.routerId) lines.push(` eigrp router-id ${process.routerId}`);
    for (const network of process.networks) lines.push(` network ${network}`);
    for (const iface of [...process.passive].sort()) lines.push(` passive-interface ${iface}`);
    for (const source of process.redistribute) lines.push(` redistribute ${source}`);
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
  if (rip.networks.length > 0 || rip.version !== null || rip.redistribute.length > 0) {
    lines.push('router rip');
    if (rip.version !== null) lines.push(` version ${rip.version}`);
    for (const network of rip.networks) lines.push(` network ${network}`);
    for (const iface of [...rip.passive].sort()) lines.push(` passive-interface ${iface}`);
    for (const neighbor of rip.neighbors) lines.push(` neighbor ${neighbor}`);
    for (const source of rip.redistribute) lines.push(` redistribute ${source}`);
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
    }
    for (const network of bgp.networks) lines.push(` network ${network}`);
    for (const source of bgp.redistribute) lines.push(` redistribute ${source}`);
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
