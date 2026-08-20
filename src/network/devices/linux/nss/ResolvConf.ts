export interface ResolvConfOptions {
  nameservers: string[];
  search: string[];
  ndots: number;
}

export function parseResolvConf(content: string): ResolvConfOptions {
  const nameservers = [...content.matchAll(/^\s*nameserver\s+(\S+)/gm)].map(m => m[1]);

  const searchLine = /^\s*search\s+(.+)$/m.exec(content);
  const domainLine = /^\s*domain\s+(\S+)/m.exec(content);
  const search = searchLine
    ? searchLine[1].trim().split(/\s+/)
    : domainLine ? [domainLine[1]] : [];

  let ndots = 1;
  for (const m of content.matchAll(/^\s*options\s+(.+)$/gm)) {
    const nd = /ndots:(\d+)/.exec(m[1]);
    if (nd) ndots = parseInt(nd[1], 10);
  }

  return { nameservers, search, ndots };
}

export function searchCandidates(name: string, search: readonly string[], ndots: number): string[] {
  if (name.endsWith('.')) return [name.slice(0, -1)];
  if (search.length === 0) return [name];

  const dots = (name.match(/\./g) ?? []).length;
  const suffixed = search.map(domain => `${name}.${domain}`);
  return dots >= ndots ? [name, ...suffixed] : [...suffixed, name];
}
