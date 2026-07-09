/**
 * Parser for the resolver-relevant directives of `/etc/resolv.conf`:
 * `nameserver`, `search`/`domain`, and `options ndots:N`. Used by the
 * `dns` NSS source to reproduce glibc's search-list qualification of
 * short (unqualified) names — a behavior specific to the stub resolver
 * (`gethostbyname`/`getaddrinfo`), never applied by `dig`/`nslookup`,
 * which always query exactly the name given on the command line.
 */

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

/**
 * Candidate names to try, in order, for a `gethostbyname`-style lookup —
 * mirrors glibc's resolv.conf(5) search-list qualification: a name with
 * fewer dots than `ndots` is tried search-suffixed first, then absolute;
 * a name with `ndots` dots or more (or a trailing dot, meaning already
 * fully-qualified) is tried absolute first, then search-suffixed as a
 * fallback.
 */
export function searchCandidates(name: string, search: readonly string[], ndots: number): string[] {
  if (name.endsWith('.')) return [name.slice(0, -1)];
  if (search.length === 0) return [name];

  const dots = (name.match(/\./g) ?? []).length;
  const suffixed = search.map(domain => `${name}.${domain}`);
  return dots >= ndots ? [name, ...suffixed] : [...suffixed, name];
}
