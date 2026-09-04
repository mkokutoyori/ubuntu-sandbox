const WILDCARD_CHARS = /[*?]/;

export function hasWildcard(pattern: string): boolean {
  return WILDCARD_CHARS.test(pattern);
}

export function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function wildcardMatches(pattern: string, value: string): boolean {
  return wildcardToRegex(pattern).test(value);
}
