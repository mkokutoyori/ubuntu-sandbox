import type { WinACE, WindowsFileSystem } from './WindowsFileSystem';

export interface FsPrincipal {
  readonly name: string;
  readonly groups: readonly string[];
  readonly administrator: boolean;
}

export type FsRight = 'read' | 'write';

const DENIED = { ok: false, error: 'Access is denied.' } as const;

function lastSegment(principal: string): string {
  return principal.slice(principal.lastIndexOf('\\') + 1).toLowerCase();
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('\\');
  return cut <= 2 ? path.slice(0, 3) : path.slice(0, cut);
}

function inheritedAcl(fs: WindowsFileSystem, path: string): readonly WinACE[] {
  let current = path;
  for (;;) {
    const entry = fs.resolve(current);
    if (entry !== null && entry.acl.length > 0) return entry.acl;
    if (entry !== null && entry.aclProtected === true) return [];
    if (current.length <= 3) return [];
    current = parentOf(current);
  }
}

function identities(who: FsPrincipal): ReadonlySet<string> {
  return new Set([
    who.name.toLowerCase(), 'everyone', 'authenticated users', 'users', 'interactive',
    ...who.groups.map((group) => group.toLowerCase()),
  ]);
}

function grants(permissions: readonly string[], right: FsRight): boolean {
  return permissions.some((permission) => {
    const word = permission.toLowerCase();
    if (word === 'fullcontrol' || word === 'modify') return true;
    return right === 'read' ? word === 'read' || word === 'readandexecute' : word === 'write';
  });
}

export function permits(fs: WindowsFileSystem, path: string, who: FsPrincipal, right: FsRight): boolean {
  if (who.administrator) return true;
  const acl = inheritedAcl(fs, path);
  if (acl.length === 0) return true;
  const held = identities(who);
  const applies = (ace: WinACE): boolean => held.has(lastSegment(ace.principal));
  if (acl.some((ace) => ace.type === 'deny' && applies(ace) && grants(ace.permissions, right))) return false;
  return acl.some((ace) => ace.type === 'allow' && applies(ace) && grants(ace.permissions, right));
}

function nearestExisting(fs: WindowsFileSystem, path: string): string {
  let current = path;
  while (current.length > 3 && !fs.exists(current)) current = parentOf(current);
  return current;
}

function mayCreateAt(fs: WindowsFileSystem, path: string, who: FsPrincipal): boolean {
  return fs.exists(path) ? permits(fs, path, who, 'write') : permits(fs, nearestExisting(fs, parentOf(path)), who, 'write');
}

function mayRemove(fs: WindowsFileSystem, path: string, who: FsPrincipal): boolean {
  return permits(fs, path, who, 'write') || permits(fs, parentOf(path), who, 'write');
}

type Guard = (fs: WindowsFileSystem, who: FsPrincipal, args: readonly unknown[]) => unknown | null;

const GUARDS: Readonly<Record<string, Guard>> = {
  readFile: (fs, who, [path]) => (permits(fs, path as string, who, 'read') ? null : DENIED),
  createFile: (fs, who, [path]) => (mayCreateAt(fs, path as string, who) ? null : DENIED),
  appendFile: (fs, who, [path]) => (mayCreateAt(fs, path as string, who) ? null : DENIED),
  mkdir: (fs, who, [path]) => (mayCreateAt(fs, path as string, who) ? null : DENIED),
  rmdir: (fs, who, [path]) => (mayRemove(fs, path as string, who) ? null : DENIED),
  rmdirRecursive: (fs, who, [path]) => (mayRemove(fs, path as string, who) ? null : DENIED),
  deleteFile: (fs, who, [path]) => (mayRemove(fs, path as string, who) ? null : DENIED),
  deleteDirectory: (fs, who, [path]) => (mayRemove(fs, path as string, who) ? null : DENIED),
  moveFile: (fs, who, [from, to]) => (mayRemove(fs, from as string, who) && mayCreateAt(fs, to as string, who) ? null : DENIED),
  renameEntry: (fs, who, [path]) => (mayRemove(fs, path as string, who) ? null : DENIED),
  listDirectory: (fs, who, [path]) => (permits(fs, path as string, who, 'read') ? null : []),
  deleteGlob: (fs, who, [directory]) => (permits(fs, directory as string, who, 'write') ? null : 0),
};

export function guardedFileSystem(fs: WindowsFileSystem, who: FsPrincipal): WindowsFileSystem {
  if (who.administrator) return fs;
  return new Proxy(fs, {
    get(target, property) {
      const original = Reflect.get(target, property, target) as unknown;
      if (typeof original !== 'function') return original;
      const guard = typeof property === 'string' ? GUARDS[property] : undefined;
      return (...args: unknown[]) => {
        const refusal = guard?.(target, who, args) ?? null;
        return refusal !== null ? refusal : (original as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export function principalOf(
  users: { getGroupsForUser(name: string): Array<{ name: string }>; isAdmin(name?: string): boolean },
  name: string,
): FsPrincipal {
  return { name, groups: users.getGroupsForUser(name).map((group) => group.name), administrator: users.isAdmin(name) };
}

export function accessDenied(fs: WindowsFileSystem, path: string, who: FsPrincipal, right: FsRight): boolean {
  return !permits(fs, path, who, right);
}
