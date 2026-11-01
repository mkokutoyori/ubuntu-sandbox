import type { SmbStatus } from './SmbStatus';

export type ShareTarget =
  | { ok: true; abs: string; parent: string; root: boolean }
  | { ok: false; status: SmbStatus };

const INVALID_NAME_CHARACTERS = /[<>"|?*:]/;

export function shareTarget(sharePath: string, requested: unknown): ShareTarget {
  if (sharePath === '') return { ok: false, status: 'STATUS_OBJECT_NAME_NOT_FOUND' };
  const text = String(requested ?? '');
  if (/^[\\/]/.test(text)) return { ok: false, status: 'STATUS_INVALID_PARAMETER' };
  const parts = text.split(/[\\/]/).filter(part => part !== '');
  const climbsFromSubfolder = parts.length > 1 && parts[1] === '..' && parts[0] !== '.' && parts[0] !== '..';
  if (climbsFromSubfolder) return { ok: false, status: 'STATUS_INVALID_PARAMETER' };
  const names: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      if (names.length === 0) return { ok: false, status: 'STATUS_INVALID_PARAMETER' };
      names.pop();
      continue;
    }
    if (INVALID_NAME_CHARACTERS.test(part)) return { ok: false, status: 'STATUS_OBJECT_NAME_INVALID' };
    names.push(part);
  }
  const base = sharePath.replace(/\\+$/, '');
  if (names.length === 0) return { ok: true, abs: sharePath, parent: sharePath, root: true };
  const abs = `${base}\\${names.join('\\')}`;
  return { ok: true, abs, parent: names.length === 1 ? sharePath : `${base}\\${names.slice(0, -1).join('\\')}`, root: false };
}
