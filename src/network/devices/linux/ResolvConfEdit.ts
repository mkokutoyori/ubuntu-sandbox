const SEARCH = /^\s*search\s+(.*)$/;

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

function searchIndex(all: readonly string[]): number {
  return all.findIndex((line) => SEARCH.test(line));
}

function done(all: readonly string[]): string {
  return all.length === 0 ? '' : `${all.join('\n')}\n`;
}

export function addNameserver(text: string, address: string): string {
  const all = lines(text);
  if (all.some((line) => line.trim() === `nameserver ${address}`)) return done(all);
  return done([...all, `nameserver ${address}`]);
}

export function removeNameserver(text: string, address: string): string {
  return done(lines(text).filter((line) => line.trim() !== `nameserver ${address}`));
}

export function addSearchDomain(text: string, domain: string): string {
  const all = lines(text);
  const at = searchIndex(all);
  if (at === -1) return done([`search ${domain}`, ...all]);
  const present = all[at].match(SEARCH)![1].trim().split(/\s+/);
  if (present.includes(domain)) return done(all);
  all[at] = `search ${[...present, domain].join(' ')}`;
  return done(all);
}

export function removeSearchDomain(text: string, domain: string): string {
  const all = lines(text);
  const at = searchIndex(all);
  if (at === -1) return done(all);
  const kept = all[at].match(SEARCH)![1].trim().split(/\s+/).filter((entry) => entry !== domain);
  if (kept.length === 0) all.splice(at, 1);
  else all[at] = `search ${kept.join(' ')}`;
  return done(all);
}
