import type { VirtualFileSystem } from '../VirtualFileSystem';

export type Existence = 'all' | 'parents' | 'none';

export type Canonical = { readonly path: string } | { readonly error: 'No such file or directory' | 'Not a directory' | 'Too many levels of symbolic links' };

const MAX_LINKS = 40;

function lexical(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function canonicalize(
  vfs: VirtualFileSystem, name: string, cwd: string, existence: Existence, options: { logical: boolean; stripSymlinks: boolean },
): Canonical {
  const absolute = name.startsWith('/') ? name : `${cwd.replace(/\/$/, '')}/${name}`;
  if (options.stripSymlinks) {
    const flat = lexical(absolute);
    if (existence !== 'none' && (existence === 'all' || flat !== '/') && vfs.lstat(flat) === null) {
      if (existence === 'all') return { error: 'No such file or directory' };
      const parent = flat.slice(0, flat.lastIndexOf('/')) || '/';
      if (vfs.lstat(parent) === null) return { error: 'No such file or directory' };
    }
    return { path: flat };
  }
  const queue = (options.logical ? lexical(absolute) : absolute).split('/').filter((part) => part !== '');
  let resolved = '/';
  let links = 0;
  while (queue.length > 0) {
    const part = queue.shift() as string;
    if (part === '.') continue;
    if (part === '..') {
      resolved = resolved.slice(0, resolved.lastIndexOf('/')) || '/';
      continue;
    }
    const candidate = `${resolved === '/' ? '' : resolved}/${part}`;
    const node = vfs.lstat(candidate);
    if (node === null) {
      const isLast = queue.length === 0;
      if (existence === 'none' || (existence === 'parents' && isLast)) {
        resolved = candidate;
        continue;
      }
      return { error: 'No such file or directory' };
    }
    if (node.type === 'symlink') {
      links += 1;
      if (links > MAX_LINKS) return { error: 'Too many levels of symbolic links' };
      const target = vfs.linkTarget(node);
      if (target.startsWith('/')) resolved = '/';
      queue.unshift(...target.split('/').filter((piece) => piece !== ''));
      continue;
    }
    if (node.type !== 'directory' && queue.length > 0) {
      if (existence === 'none') { resolved = candidate; continue; }
      return { error: 'Not a directory' };
    }
    resolved = candidate;
  }
  return { path: resolved };
}

export function relativePath(path: string, from: string): string {
  const target = path.split('/').filter((part) => part !== '');
  const base = from.split('/').filter((part) => part !== '');
  let common = 0;
  while (common < target.length && common < base.length && target[common] === base[common]) common++;
  const pieces = [...base.slice(common).map(() => '..'), ...target.slice(common)];
  return pieces.length === 0 ? '.' : pieces.join('/');
}
