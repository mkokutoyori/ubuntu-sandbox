export interface PathResolution {
  readonly words: readonly string[];
  readonly ambiguous?: { readonly typed: string; readonly candidates: readonly string[] };
}

export interface PathVocabulary {
  (prefix: readonly string[]): readonly string[];
}

export const FORTI_GET_VIEWS: ReadonlyArray<readonly string[]> = Object.freeze([
  Object.freeze(['system', 'status']),
  Object.freeze(['system', 'performance', 'status']),
  Object.freeze(['system', 'arp']),
  Object.freeze(['system', 'ha', 'status']),
  Object.freeze(['system', 'interface']),
  Object.freeze(['system', 'interface', 'physical']),
  Object.freeze(['system', 'fortiguard-service', 'status']),
  Object.freeze(['vpn', 'ipsec', 'tunnel', 'summary']),
  Object.freeze(['vpn', 'ipsec', 'tunnel', 'details']),
  Object.freeze(['vpn', 'ipsec', 'tunnel', 'name']),
  Object.freeze(['router', 'info', 'ospf', 'neighbor']),
  Object.freeze(['router', 'info', 'bgp', 'summary']),
  Object.freeze(['router', 'info', 'bgp', 'neighbors']),
  Object.freeze(['router', 'info', 'routing-table', 'all']),
  Object.freeze(['router', 'info', 'routing-table', 'static']),
  Object.freeze(['router', 'info', 'routing-table', 'connected']),
  Object.freeze(['router', 'info', 'routing-table', 'database']),
  Object.freeze(['router', 'info', 'routing-table', 'ospf']),
  Object.freeze(['router', 'info', 'routing-table', 'rip']),
  Object.freeze(['router', 'info', 'routing-table', 'bgp']),
  Object.freeze(['router', 'info6', 'routing-table']),
]);

export function resolvePathWords(
  typed: readonly string[], vocabulary: PathVocabulary,
): PathResolution {
  const words: string[] = [];

  for (const word of typed) {
    const known = [...new Set(vocabulary(words))];
    if (known.includes(word) || known.length === 0) {
      words.push(word);
      continue;
    }

    const candidates = known.filter(name => name.startsWith(word));
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
