export function expandHomePath(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~\\') || path.startsWith('~/')) return `${home.replace(/\\+$/, '')}\\${path.slice(2)}`;
  return path;
}
