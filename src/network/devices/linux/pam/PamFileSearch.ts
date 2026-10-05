export function searchKey(readFile: (path: string) => string | null, path: string, key: string): string | null {
  const content = readFile(path);
  if (content === null) return null;
  for (const raw of content.split('\n')) {
    const hash = raw.indexOf('#');
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).replace(/^\s+/, '');
    if (line === '') continue;
    const separator = line.search(/[ \t=]/);
    const name = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator).replace(/^[\s=]+/, '');
    if (name.toLowerCase() === key.toLowerCase()) return value;
  }
  return null;
}

export function parseOctal(text: string): number | null {
  const match = /^\s*\+?([0-7]+)/.exec(text);
  return match === null ? null : parseInt(match[1], 8);
}
