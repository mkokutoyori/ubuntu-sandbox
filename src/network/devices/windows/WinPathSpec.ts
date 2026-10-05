import { wildcardToRegex } from '@/powershell/runtime/PSWildcard';
import type { WindowsFileSystem } from './WindowsFileSystem';

export interface FileSpec {
  readonly directory: string;
  readonly pattern: string | null;
}

export const hasWildcard = (text: string): boolean => /[*?]/.test(text);

export function nameMatcher(pattern: string | null): (name: string) => boolean {
  if (pattern === null || pattern === '*' || pattern === '*.*') return () => true;
  const expression = wildcardToRegex(pattern);
  return name => expression.test(name);
}

export function splitFileSpec(fs: WindowsFileSystem, cwd: string, spec: string): FileSpec | null {
  if (hasWildcard(spec)) {
    const separator = Math.max(spec.lastIndexOf('\\'), spec.lastIndexOf('/'));
    const directory = separator >= 0 ? fs.normalizePath(spec.slice(0, separator + 1), cwd) : cwd;
    return fs.isDirectory(directory) ? { directory, pattern: spec.slice(separator + 1) } : null;
  }

  const absolute = fs.normalizePath(spec, cwd);
  if (fs.isDirectory(absolute)) return { directory: absolute, pattern: null };
  const lastSeparator = absolute.lastIndexOf('\\');
  const parent = lastSeparator <= 2 ? absolute.slice(0, lastSeparator + 1) : absolute.slice(0, lastSeparator);
  if (!fs.isDirectory(parent)) return null;
  return { directory: parent, pattern: absolute.slice(lastSeparator + 1) };
}

export function joinPath(directory: string, name: string): string {
  return directory.endsWith('\\') ? `${directory}${name}` : `${directory}\\${name}`;
}
