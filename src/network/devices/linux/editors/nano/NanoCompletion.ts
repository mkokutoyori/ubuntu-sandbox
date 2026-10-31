import type { EditorFsContext } from '../EditorFsContext';
import { breadth } from './NanoText';

export const PRESENT_PATH = './';

export type CompletionHost = Pick<EditorFsContext, 'resolvePath' | 'exists' | 'kindOf' | 'listDirectory' | 'userNames'>;

export interface FileCompletion {
  readonly answer: string;
  readonly list: readonly string[] | null;
}

export type EntryFilter = (fullName: string) => boolean;

function codePoints(text: string): number[] {
  return [...text].map((ch) => ch.codePointAt(0)!);
}

function compareCodePoints(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function caseBlindCompare(a: string, b: string): number {
  const difference = compareCodePoints(codePoints(a.toLowerCase()), codePoints(b.toLowerCase()));
  return difference !== 0 ? difference : compareCodePoints(codePoints(a), codePoints(b));
}

function isDirectory(host: CompletionHost, path: string): boolean {
  return host.kindOf?.(host.resolvePath(path)) === 'directory';
}

function directoryMatches(host: CompletionHost, morsel: string, allowed: EntryFilter): string[] | null {
  const slash = morsel.lastIndexOf('/');
  const filename = slash < 0 ? morsel : morsel.slice(slash + 1);
  let directory = slash < 0 ? PRESENT_PATH : morsel.slice(0, slash + 1);
  if (!directory.startsWith('/') && slash >= 0) directory = `${PRESENT_PATH}${directory}`;
  const names = host.listDirectory?.(directory);
  if (names === null || names === undefined) return null;
  return names.filter((name) => name.startsWith(filename) && name !== '.' && name !== '..' && allowed(`${directory}${name}`));
}

function sortedForListing(host: CompletionHost, matches: readonly string[]): string[] {
  return [...matches].sort((a, b) => {
    const aIsDirectory = isDirectory(host, a);
    const bIsDirectory = isDirectory(host, b);
    if (aIsDirectory && !bIsDirectory) return -1;
    if (!aIsDirectory && bIsDirectory) return 1;
    return caseBlindCompare(a, b);
  });
}

function commonPrefixOf(matches: readonly string[]): string {
  const first = [...matches[0]];
  let length = 0;
  while (length < first.length && matches.every((match) => [...match][length] === first[length])) length++;
  return first.slice(0, length).join('');
}

function completeUserName(host: CompletionHost, morsel: string): FileCompletion | null {
  const matches = (host.userNames?.() ?? []).map((name) => `~${name}`).filter((name) => name.startsWith(morsel));
  if (matches.length === 0) return null;
  const shared = commonPrefixOf(matches);
  const answer = matches.length === 1 ? `${shared}/` : shared;
  return { answer: answer.length !== morsel.length ? answer : morsel, list: matches.length > 1 ? sortedForListing(host, matches) : null };
}

export function completeFileName(host: CompletionHost, morsel: string, allowed: EntryFilter = () => true): FileCompletion | null {
  if (morsel.startsWith('~') && !morsel.includes('/')) return completeUserName(host, morsel);
  const matches = directoryMatches(host, morsel, allowed);
  if (matches === null || matches.length === 0) return null;
  const lastSlash = morsel.lastIndexOf('/');
  const path = lastSlash < 0 ? '' : morsel.slice(0, lastSlash + 1);
  let shared = `${path}${commonPrefixOf(matches)}`;
  if (matches.length === 1 && (isDirectory(host, shared) || isDirectory(host, `${PRESENT_PATH}${shared}`))) shared += '/';
  const answer = shared.length !== morsel.length ? shared : morsel;
  return { answer, list: matches.length > 1 ? sortedForListing(host, matches) : null };
}

export interface CompletionLayout {
  readonly rows: readonly (readonly string[])[];
  readonly firstRow: number;
  readonly columnWidth: number;
  readonly columns: number;
  readonly more: boolean;
}

export function layoutCompletions(names: readonly string[], cols: number, editRows: number, hiddenRows: number, tabsize: number): CompletionLayout {
  const lastRow = editRows - 1 - hiddenRows;
  let longest = Math.max(...names.map((name) => breadth(name, tabsize)));
  if (longest > cols - 1) longest = cols - 1;
  const columns = Math.max(1, Math.floor((cols + 1) / (longest + 2)));
  const rowCount = Math.ceil(names.length / columns);
  const firstRow = rowCount < lastRow ? lastRow - rowCount : 0;
  const rows: string[][] = [];
  let row = firstRow;
  let more = false;
  for (let index = 0; index < names.length; index++) {
    if (row === lastRow && (index + 1) % columns === 0 && index + 1 < names.length) {
      (rows[row - firstRow] ??= []).push('(more)');
      more = true;
      break;
    }
    (rows[row - firstRow] ??= []).push(names[index]);
    if ((index + 1) % columns === 0) row++;
  }
  return { rows, firstRow, columnWidth: longest + 2, columns, more };
}

export function nextHistoryCompletion(history: readonly string[], position: number, answer: string, fragmentLength: number): { position: number; text: string } | null {
  const fragment = answer.slice(0, fragmentLength);
  for (let index = position - 1; index >= 0; index--) {
    if (history[index].startsWith(fragment)) return { position: index, text: history[index] };
  }
  for (let index = history.length; index > position; index--) {
    const text = index === history.length ? '' : history[index];
    if (text.startsWith(fragment)) return { position: index, text };
  }
  return null;
}
