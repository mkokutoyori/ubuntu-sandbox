import { hasWildcard, wildcardToRegex } from '@/powershell/runtime/PSWildcard';
import type { WordScan } from '@/terminal/completion/words';

export const CMD_COMPLETION_WORDS: WordScan = { quotes: ['"'], breakers: '', separators: '', escape: null };

export type PathCompletionStyle = 'powershell' | 'cmd' | 'literal';

export interface PathCompletionFileSystem {
  normalizePath(path: string, cwd: string): string;
  listDirectory(absPath: string): ReadonlyArray<{ readonly name: string; readonly entry: { readonly type: string } }>;
}

export interface PathCompletionRequest {
  readonly token: string;
  readonly cwd: string;
  readonly home: string | null;
  readonly directoriesOnly: boolean;
  readonly style: PathCompletionStyle;
}

const POWERSHELL_NEEDS_QUOTES = /[\s'`$(){};,&|]/;
const CMD_NEEDS_QUOTES = /[\s&^()<>|,;=]/;
const HOME_PREFIX = /^~(?:[\\/]|$)/;

export function openingQuoteOf(token: string, style: PathCompletionStyle): string {
  const first = token[0];
  if (style === 'literal') return '';
  if (first === '"' || (style === 'powershell' && first === "'")) return first;
  return '';
}

export function stripQuotes(token: string, quote: string): string {
  if (quote === '') return token;
  const inner = token.slice(1);
  return inner.endsWith(quote) ? inner.slice(0, -1) : inner;
}

export function quotePath(text: string, quote: string, style: PathCompletionStyle): string {
  if (quote !== '') return `${quote}${quote === "'" ? text.replace(/'/g, "''") : text}${quote}`;
  if (style === 'powershell' && POWERSHELL_NEEDS_QUOTES.test(text)) return `'${text.replace(/'/g, "''")}'`;
  if (style === 'cmd' && CMD_NEEDS_QUOTES.test(text)) return `"${text}"`;
  return text;
}

export function splitPathSeparator(path: string): { readonly directory: string; readonly name: string } {
  const separator = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return { directory: path.slice(0, separator + 1), name: path.slice(separator + 1) };
}

export function pathLooksLikeAPath(text: string): boolean {
  return /[\\/]/.test(text) || /^[A-Za-z]:/.test(text) || text.startsWith('~');
}

function resolvedDirectory(directory: string, request: PathCompletionRequest, fs: PathCompletionFileSystem): string | null {
  if (directory === '') return request.cwd;
  if (directory.startsWith('\\\\') || directory.startsWith('//')) return null;
  const expanded = request.home !== null && HOME_PREFIX.test(directory) ? request.home + directory.slice(1) : directory;
  return fs.normalizePath(expanded, request.cwd);
}

export function completeWindowsPath(fs: PathCompletionFileSystem, request: PathCompletionRequest): string[] {
  const quote = openingQuoteOf(request.token, request.style);
  const { directory, name } = splitPathSeparator(stripQuotes(request.token, quote));
  const listed = resolvedDirectory(directory, request, fs);
  if (listed === null) return [];

  const matches = hasWildcard(name)
    ? wildcardToRegex(`${name}*`)
    : null;
  const lowered = name.toLowerCase();
  const typedDirectory = directory.replace(/\//g, '\\');

  return fs.listDirectory(listed)
    .filter(item => (matches ? matches.test(item.name) : item.name.toLowerCase().startsWith(lowered)))
    .filter(item => !request.directoriesOnly || item.entry.type === 'directory')
    .sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()))
    .map(item => {
      const closing = item.entry.type === 'directory' && request.style !== 'cmd' ? '\\' : '';
      return quotePath(`${typedDirectory}${item.name}${closing}`, quote, request.style);
    });
}
