export type ServerNameClass = 'exact' | 'leading-wildcard' | 'trailing-wildcard' | 'regex';

const CLASS_ORDER: Readonly<Record<ServerNameClass, number>> = {
  exact: 0, 'leading-wildcard': 1, 'trailing-wildcard': 2, regex: 3,
};

export function serverNameClass(pattern: string): ServerNameClass {
  if (pattern.startsWith('~')) return 'regex';
  if (pattern.startsWith('*.') || pattern.startsWith('.')) return 'leading-wildcard';
  if (pattern.endsWith('.*')) return 'trailing-wildcard';
  return 'exact';
}

function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern.slice(1));
  } catch {
    return null;
  }
}

export function serverNameMatches(pattern: string, host: string): boolean {
  const name = host.split(':')[0].toLowerCase();
  switch (serverNameClass(pattern)) {
    case 'regex': return compileRegex(pattern)?.test(name) ?? false;
    case 'leading-wildcard': {
      if (pattern.startsWith('.')) return name === pattern.slice(1).toLowerCase() || name.endsWith(pattern.toLowerCase());
      return name.endsWith(pattern.slice(1).toLowerCase());
    }
    case 'trailing-wildcard': return name.startsWith(pattern.slice(0, -1).toLowerCase());
    default: return pattern.toLowerCase() === name;
  }
}

export interface ServerNameEntry<T> {
  readonly pattern: string;
  readonly owner: T;
}

export function orderServerNames<T>(entries: readonly ServerNameEntry<T>[]): ServerNameEntry<T>[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const byClass = CLASS_ORDER[serverNameClass(a.entry.pattern)] - CLASS_ORDER[serverNameClass(b.entry.pattern)];
      if (byClass !== 0) return byClass;
      const classA = serverNameClass(a.entry.pattern);
      if (classA === 'leading-wildcard' || classA === 'trailing-wildcard') {
        const byLength = b.entry.pattern.length - a.entry.pattern.length;
        if (byLength !== 0) return byLength;
      }
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

export function findServerByName<T>(entries: readonly ServerNameEntry<T>[], host: string): T | null {
  for (const entry of orderServerNames(entries)) {
    if (entry.pattern !== '_' && entry.pattern !== '' && serverNameMatches(entry.pattern, host)) return entry.owner;
  }
  return null;
}
