import type { VirtualFileSystem } from '../VirtualFileSystem';
import { quoteLocale } from './CoreutilsKit';

export type BackupControl = 'none' | 'numbered' | 'existing' | 'simple';

const BACKUP_WORDS: readonly (readonly [string, BackupControl])[] = [
  ['none', 'none'], ['off', 'none'], ['simple', 'simple'], ['never', 'simple'],
  ['existing', 'existing'], ['nil', 'existing'], ['numbered', 'numbered'], ['t', 'numbered'],
];

const BACKUP_LIST: readonly string[] = ['none, off', 'simple, never', 'existing, nil', 'numbered, t'];

export function argumentFailure(
  program: string, kind: 'invalid' | 'ambiguous', word: string, context: string, valid: readonly string[],
): string {
  const lines = valid.map((entry) => `  - ${entry.split(', ').map(quoteLocale).join(', ')}`);
  return `${program}: ${kind} argument ${quoteLocale(word)} for ${quoteLocale(context)}\nValid arguments are:\n${lines.join('\n')}`;
}

export function matchArgument<T>(word: string, table: readonly (readonly [string, T])[]): T | 'invalid' | 'ambiguous' {
  const exact = table.find(([name]) => name === word);
  if (exact !== undefined) return exact[1];
  const candidates = table.filter(([name]) => word !== '' && name.startsWith(word));
  if (candidates.length === 0) return 'invalid';
  return candidates.every(([, value]) => value === candidates[0][1]) ? candidates[0][1] : 'ambiguous';
}

export function parseBackupControl(program: string, word: string | undefined): BackupControl | string {
  if (word === undefined || word === '') return 'existing';
  const matched = matchArgument(word, BACKUP_WORDS);
  if (matched !== 'invalid' && matched !== 'ambiguous') return matched;
  return argumentFailure(program, matched, word, 'backup type', BACKUP_LIST);
}

function numberedBackupIndex(vfs: VirtualFileSystem, path: string): number {
  const slash = path.lastIndexOf('/');
  const directory = slash <= 0 ? '/' : path.slice(0, slash);
  const base = path.slice(slash + 1);
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.~(\\d+)~$`);
  let highest = 0;
  for (const entry of vfs.listDirectory(directory) ?? []) {
    const match = pattern.exec(entry.name);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

export function backupPathFor(vfs: VirtualFileSystem, path: string, control: BackupControl, suffix: string): string | null {
  if (control === 'none') return null;
  const highest = numberedBackupIndex(vfs, path);
  if (control === 'numbered' || (control === 'existing' && highest > 0)) return `${path}.~${highest + 1}~`;
  return `${path}${suffix}`;
}

export function makeBackup(vfs: VirtualFileSystem, path: string, control: BackupControl, suffix: string): string | null {
  const backup = backupPathFor(vfs, path, control, suffix);
  if (backup === null) return null;
  if (vfs.lstat(backup) !== null) vfs.deleteFile(backup);
  return vfs.rename(path, backup) ? backup : null;
}
