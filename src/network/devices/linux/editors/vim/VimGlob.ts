export interface GlobFileSystem {
  entries(directory: string): string[] | null;
  isDirectory(path: string): boolean;
  exists(path: string): boolean;
  home(): string | null;
}

const WILDCARDS = /[*?[{]/;

export function hasWildcard(pattern: string): boolean {
  return WILDCARDS.test(pattern);
}

export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open < 0) return [pattern];
  let depth = 0;
  for (let at = open; at < pattern.length; at++) {
    if (pattern[at] === '{') depth++;
    else if (pattern[at] === '}') {
      depth--;
      if (depth === 0) {
        const alternatives = splitTopLevel(pattern.slice(open + 1, at));
        if (alternatives.length < 2) return [pattern];
        return alternatives.flatMap((alternative) => expandBraces(pattern.slice(0, open) + alternative + pattern.slice(at + 1)));
      }
    }
  }
  return [pattern];
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '{') depth++;
    if (character === '}') depth--;
    if (character === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += character;
  }
  parts.push(current);
  return parts;
}

export function componentMatches(pattern: string, name: string): boolean {
  if (name.startsWith('.') && !pattern.startsWith('.')) return false;
  let source = '^';
  for (let at = 0; at < pattern.length; at++) {
    const character = pattern[at];
    if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else if (character === '[') {
      const close = pattern.indexOf(']', at + 2);
      if (close < 0) { source += '\\['; continue; }
      let body = pattern.slice(at + 1, close);
      const negate = body.startsWith('!') || body.startsWith('^');
      if (negate) body = body.slice(1);
      source += `[${negate ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')}]`;
      at = close;
    } else source += character.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 'u').test(name);
}

function sortedNames(names: string[]): string[] {
  return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function join(base: string, name: string): string {
  if (base === '') return name;
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

function descendants(base: string, fs: GlobFileSystem, resolved: (path: string) => string, withFiles = false, depth = 0): string[] {
  if (depth > 20) return [];
  const names = fs.entries(resolved(base)) ?? [];
  const found: string[] = [];
  for (const name of sortedNames(names)) {
    if (name.startsWith('.')) continue;
    const path = join(base, name);
    if (fs.isDirectory(resolved(path))) {
      found.push(path);
      found.push(...descendants(path, fs, resolved, withFiles, depth + 1));
    } else if (withFiles) found.push(path);
  }
  return found;
}

function walk(bases: string[], components: string[], fs: GlobFileSystem, resolved: (path: string) => string): string[] {
  if (components.length === 0) return bases;
  const [component, ...rest] = components;
  const next: string[] = [];
  for (const base of bases) {
    if (component === '**' && rest.length === 0) {
      next.push(...descendants(base, fs, resolved, true));
      continue;
    }
    if (component === '**') {
      next.push(...walk([base, ...descendants(base, fs, resolved)], rest, fs, resolved));
      continue;
    }
    if (!hasWildcard(component)) {
      const path = join(base, component);
      if (fs.exists(resolved(path))) next.push(...walk([path], rest, fs, resolved));
      continue;
    }
    const names = fs.entries(resolved(base === '' ? '.' : base)) ?? [];
    const candidates = component.startsWith('.') ? ['.', '..', ...names] : names;
    for (const name of sortedNames(candidates)) {
      if (!componentMatches(component, name)) continue;
      const path = join(base, name);
      if (rest.length > 0 && !fs.isDirectory(resolved(path))) continue;
      next.push(...walk([path], rest, fs, resolved));
    }
  }
  return next;
}

export function globPaths(pattern: string, fs: GlobFileSystem, resolved: (path: string) => string): string[] {
  const results: string[] = [];
  for (const alternative of expandBraces(pattern)) {
    let text = alternative;
    if (text === '~' || text.startsWith('~/')) text = (fs.home() ?? '~') + text.slice(1);
    if (text === '') continue;
    const absolute = text.startsWith('/');
    const components = text.split('/').filter((component) => component !== '');
    const bases = [absolute ? '/' : ''];
    const found = walk(bases, components, fs, resolved).filter((path) => path !== '');
    for (const path of found) if (!results.includes(path)) results.push(path);
  }
  return results;
}
