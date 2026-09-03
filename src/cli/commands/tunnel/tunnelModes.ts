export interface TunnelMode {
  readonly keyword: string;
  readonly description: string;
}

export const TUNNEL_MODES: readonly TunnelMode[] = Object.freeze([
  { keyword: 'gre ip', description: 'GRE over IP' },
  { keyword: 'gre multipoint', description: 'Multipoint GRE over IP' },
  { keyword: 'ipip', description: 'IP over IP encapsulation' },
  { keyword: 'ipsec ipv4', description: 'IPSec tunnel over IPv4' },
  { keyword: 'ipv6ip', description: 'IPv6 over IP encapsulation' },
  { keyword: 'mpls', description: 'MPLS encapsulation' },
]);

const BY_KEYWORD = new Set(TUNNEL_MODES.map((m) => m.keyword));

export function isTunnelMode(mode: string): boolean {
  return BY_KEYWORD.has(mode.trim().toLowerCase().replace(/\s+/g, ' '));
}

export function isTunnelModeHead(word: string): boolean {
  const head = word.trim().toLowerCase();
  return TUNNEL_MODES.some((m) => m.keyword.split(' ')[0] === head);
}
