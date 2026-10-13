import type { EditorFsContext, EditorPathKind } from '../EditorFsContext';

export interface NanoOpening {
  readonly path: string;
  readonly alert: string | null;
  readonly lockable: boolean;
}

export function directoryNameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') return path.startsWith('/') ? '/' : '.';
  const slash = trimmed.lastIndexOf('/');
  if (slash < 0) return '.';
  const parent = trimmed.slice(0, slash).replace(/\/+$/, '');
  return parent === '' ? '/' : parent;
}

function kindOfTyped(typed: string, fs: EditorFsContext): EditorPathKind {
  const absolute = fs.resolvePath(typed);
  return fs.kindOf?.(absolute) ?? (fs.exists(absolute) ? 'file' : 'missing');
}

export function fullPathOf(typed: string, fs: EditorFsContext): string | null {
  const absolute = fs.resolvePath(typed);
  const kind = kindOfTyped(typed, fs);
  if (kind !== 'missing') return kind === 'directory' && absolute !== '/' ? `${absolute}/` : absolute;
  const slash = typed.lastIndexOf('/');
  const parent = slash < 0 ? '.' : typed.slice(0, slash) || '/';
  if (kindOfTyped(parent, fs) !== 'directory') return null;
  const base = fs.resolvePath(parent);
  return `${base === '/' ? '' : base}/${slash < 0 ? typed : typed.slice(slash + 1)}`;
}

const REFUSED_KINDS = { directory: 'a directory', device: 'a device file', fifo: 'a FIFO' } as const;

export function openingFor(typed: string, absolute: string, fs: EditorFsContext, user: string): NanoOpening {
  if (absolute === '') return { path: '', alert: null, lockable: false };
  const kind = fs.kindOf?.(absolute) ?? (fs.exists(absolute) ? 'file' : 'missing');
  if (kind === 'directory' || kind === 'device' || kind === 'fifo') {
    return { path: '', alert: `"${typed}" is ${REFUSED_KINDS[kind]}`, lockable: false };
  }
  if (kind === 'file') {
    const readOnly = user === 'root' && fs.isReadOnly?.(absolute) === true;
    return { path: absolute, alert: readOnly ? `${typed} is meant to be read-only` : null, lockable: true };
  }
  const parent = directoryNameOf(typed);
  const parentKind = fs.kindOf?.(fs.resolvePath(parent)) ?? 'directory';
  if (parentKind === 'missing') return { path: absolute, alert: `Directory '${parent}' does not exist`, lockable: false };
  if (parentKind !== 'directory') return { path: absolute, alert: `Path '${parent}' is not a directory`, lockable: false };
  return { path: absolute, alert: null, lockable: true };
}
