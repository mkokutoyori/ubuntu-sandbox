import type { AuditdConfigFs, FileInfo, FsErrno, StatResult } from '@/network/devices/linux/audit/daemon/AuditdConfig';

export const CONF = '/etc/audit/auditd.conf';
export const ROOT_FILE: FileInfo = { kind: 'file', uid: 0, gid: 0, mode: 0o640 };

export interface Lab {
  files: Map<string, { info: FileInfo; content?: string }>;
  dirs: Set<string>;
  groups: Map<string, number>;
}

export function lab(conf: string, extra: Partial<Lab> = {}): Lab {
  const files = new Map<string, { info: FileInfo; content?: string }>([[CONF, { info: ROOT_FILE, content: conf }]]);
  for (const [path, entry] of extra.files ?? []) files.set(path, entry);
  return {
    files,
    dirs: new Set(['/etc/audit', '/var/log/audit', '/var/log', '/tmp', ...(extra.dirs ?? [])]),
    groups: new Map([['adm', 4], ['root', 0], ...(extra.groups ?? [])]),
  };
}

export function fsOf(world: Lab): AuditdConfigFs {
  return {
    stat(path, follow): StatResult {
      const entry = world.files.get(path);
      if (entry === undefined) return world.dirs.has(path) ? { ok: true, info: { kind: 'directory', uid: 0, gid: 0, mode: 0o750 } } : { ok: false, errno: 'ENOENT' };
      if (entry.info.kind === 'symlink' && follow) return { ok: false, errno: 'ENOENT' };
      return { ok: true, info: entry.info };
    },
    readText: (path) => world.files.get(path)?.content ?? null,
    openDirectory: (path): FsErrno | null => (world.dirs.has(path) ? null : 'ENOENT'),
    groupGid: (name) => world.groups.get(name) ?? null,
    isExecutable: (path) => ((world.files.get(path)?.info.mode ?? 0) & 0o111) !== 0,
    hostResolves: () => true,
  };
}

