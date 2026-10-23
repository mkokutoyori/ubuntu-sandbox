import type { EditorFsContext } from '../EditorFsContext';

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

type PathHost = Pick<EditorFsContext, 'resolvePath' | 'exists' | 'kindOf' | 'canonicalPath'>;

function canonicalOf(absolute: string, fs: PathHost): string | null {
  if (fs.canonicalPath !== undefined) return fs.canonicalPath(absolute);
  return (fs.kindOf?.(absolute) ?? (fs.exists(absolute) ? 'file' : 'missing')) === 'missing' ? null : absolute;
}

function isDirectory(absolute: string, fs: PathHost): boolean {
  return (fs.kindOf?.(absolute) ?? (fs.exists(absolute) ? 'file' : 'missing')) === 'directory';
}

export function fullPathOf(typed: string, fs: PathHost): string | null {
  const real = canonicalOf(fs.resolvePath(typed), fs);
  if (real !== null) return isDirectory(real, fs) && real !== '/' ? `${real}/` : real;
  const slash = typed.lastIndexOf('/');
  const parent = slash < 0 ? '.' : typed.slice(0, slash) || '/';
  const base = canonicalOf(fs.resolvePath(parent), fs);
  if (base === null || !isDirectory(base, fs)) return null;
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
