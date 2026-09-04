export interface PathResolution {
  readonly words: readonly string[];
  readonly ambiguous?: { readonly typed: string; readonly candidates: readonly string[] };
}

export interface PathVocabulary {
  (prefix: readonly string[]): readonly string[];
}

export interface GetView {
  readonly words: readonly string[];
  readonly help: string;
}

const VIEWS: readonly GetView[] = Object.freeze([
  { words: ['system', 'status'], help: 'Firmware, serial number and uptime.' },
  { words: ['system', 'performance', 'status'], help: 'CPU, memory and throughput.' },
  { words: ['system', 'arp'], help: 'ARP cache.' },
  { words: ['system', 'ha', 'status'], help: 'Cluster members and their roles.' },
  { words: ['system', 'interface'], help: 'Interface addresses and link state.' },
  { words: ['system', 'interface', 'physical'], help: 'Physical interfaces only.' },
  { words: ['system', 'session', 'status'], help: 'Number of active sessions.' },
  { words: ['system', 'session', 'list'], help: 'Active sessions and their translation.' },
  { words: ['system', 'fortiguard-service', 'status'], help: 'FortiGuard contract state.' },
  { words: ['hardware', 'nic'], help: 'Network interface counters.' },
  { words: ['vpn', 'ipsec', 'tunnel', 'summary'], help: 'One line per tunnel.' },
  { words: ['vpn', 'ipsec', 'tunnel', 'details'],
    help: 'Tunnels and their security associations.' },
  { words: ['vpn', 'ipsec', 'tunnel', 'name'], help: 'One tunnel by name.' },
  { words: ['router', 'info', 'ospf', 'neighbor'], help: 'OSPF neighbours.' },
  { words: ['router', 'info', 'bgp', 'summary'], help: 'BGP peers and their prefix counts.' },
  { words: ['router', 'info', 'bgp', 'neighbors'], help: 'BGP peers in detail.' },
  { words: ['router', 'info', 'routing-table', 'all'], help: 'Every route.' },
  { words: ['router', 'info', 'routing-table', 'static'], help: 'Static routes only.' },
  { words: ['router', 'info', 'routing-table', 'connected'], help: 'Connected routes only.' },
  { words: ['router', 'info', 'routing-table', 'database'],
    help: 'Routes of every protocol, elected or not.' },
  { words: ['router', 'info', 'routing-table', 'ospf'], help: 'OSPF routes only.' },
  { words: ['router', 'info', 'routing-table', 'rip'], help: 'RIP routes only.' },
  { words: ['router', 'info', 'routing-table', 'bgp'], help: 'BGP routes only.' },
  { words: ['router', 'info6', 'routing-table'], help: 'IPv6 routing table.' },
]);

const VIEW_BRANCHES: readonly GetView[] = Object.freeze([
  { words: ['system', 'performance'], help: 'Performance counters.' },
  { words: ['system', 'ha'], help: 'Cluster state.' },
  { words: ['system', 'session'], help: 'Session table.' },
  { words: ['system', 'fortiguard-service'], help: 'FortiGuard subscription.' },
  { words: ['hardware'], help: 'Hardware counters.' },
  { words: ['vpn', 'ipsec', 'tunnel'], help: 'IPsec tunnels.' },
  { words: ['router', 'info'], help: 'IPv4 routing information.' },
  { words: ['router', 'info', 'ospf'], help: 'OSPF state.' },
  { words: ['router', 'info', 'bgp'], help: 'BGP state.' },
  { words: ['router', 'info', 'routing-table'], help: 'Routing table.' },
  { words: ['router', 'info6'], help: 'IPv6 routing information.' },
]);

export const FORTI_GET_VIEWS: ReadonlyArray<readonly string[]> =
  Object.freeze(VIEWS.map(view => Object.freeze(view.words)));

export function getViewHelp(path: readonly string[]): string | undefined {
  const matches = (view: GetView) => view.words.length === path.length
    && view.words.every((word, index) => word === path[index]);
  return (VIEWS.find(matches) ?? VIEW_BRANCHES.find(matches))?.help;
}

export function resolvePathWords(
  typed: readonly string[], vocabulary: PathVocabulary,
): PathResolution {
  const words: string[] = [];

  for (const word of typed) {
    const known = [...new Set(vocabulary(words))];
    const lowered = word.toLowerCase();
    const exact = known.find(name => name.toLowerCase() === lowered);
    if (exact !== undefined) { words.push(exact); continue; }
    if (known.length === 0) { words.push(word); continue; }

    const candidates = known.filter(name => name.toLowerCase().startsWith(lowered));
    if (candidates.length === 1) { words.push(candidates[0]); continue; }
    if (candidates.length > 1) {
      return { words: [...words, word], ambiguous: { typed: word, candidates } };
    }
    words.push(word);
  }

  return { words };
}

export function viewContinuations(
  views: ReadonlyArray<readonly string[]>, prefix: readonly string[],
): readonly string[] {
  const out = new Set<string>();
  for (const view of views) {
    if (view.length <= prefix.length) continue;
    if (!prefix.every((word, index) => view[index] === word)) continue;
    out.add(view[prefix.length]);
  }
  return [...out];
}
