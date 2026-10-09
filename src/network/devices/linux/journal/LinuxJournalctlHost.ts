import { simulationNowMs } from '@/network/core/SystemClock';
import type { LinuxCommandExecutor } from '../LinuxCommandExecutor';
import type { JournalctlHost, PathStat } from './JournalctlTool';
import { systemdCatalog } from './Catalog';

const INTERPRETER = /^#!\s*(\S+)/;

function randomId128(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function journalctlHost(executor: LinuxCommandExecutor): JournalctlHost {
  const { vfs, userMgr } = executor;
  const journald = executor.logMgr.journald;
  const groupNames = (): string[] => userMgr.getUserGroups(userMgr.currentUser).map((group) => group.name);
  return {
    files: () => journald.fileInfos(),
    varlink: (method) => {
      if (userMgr.currentUid !== 0) return { error: 'Access denied' };
      if (method === 'io.systemd.Journal.Rotate') {
        journald.rotate();
        executor.logMgr.syncJournalFiles();
      }
      if (method === 'io.systemd.Journal.FlushToVar') journald.markFlushed();
      return { ok: true };
    },
    vacuum: (spec) => {
      const results = journald.vacuum(spec);
      executor.logMgr.syncJournalFiles();
      return results;
    },
    flushed: () => journald.isFlushed(),
    newId128: randomId128,
    records: () => journald.records(),
    journalDirectory: () => journald.directory,
    hasJournalFiles: () => journald.records().length > 0,
    nowUsec: () => simulationNowMs() * 1000,
    zoneName: () => executor.identity.timezone || 'UTC',
    uid: () => userMgr.currentUid,
    canReadJournal: () => userMgr.currentUid === 0 || groupNames().some((name) => name === 'adm' || name === 'systemd-journal'),
    currentBootId: () => journald.bootId,
    columns: () => 80,
    hasPersistentStorage: () => vfs.resolveInode('/var/log/journal') !== null,
    statPath: (path): PathStat => {
      const absolute = vfs.normalizePath(path, executor.getCwd());
      const inode = vfs.resolveInode(absolute);
      if (!inode) return { errno: 'ENOENT' };
      if (inode.type !== 'file') return { kind: 'other' };
      const content = vfs.readFile(absolute) ?? '';
      const interpreter = INTERPRETER.exec(content)?.[1] ?? null;
      return { kind: 'regular', executable: (inode.permissions & 0o111) !== 0, interpreter, interpreterIsLink: false, name: absolute.slice(absolute.lastIndexOf('/') + 1) };
    },
    readFile: (path) => vfs.readFile(vfs.normalizePath(path, executor.getCwd())),
    writeFile: (path, content) => (vfs.writeFile(vfs.normalizePath(path, executor.getCwd()), content, userMgr.currentUid, userMgr.currentGid, 0o022) ? null : 'EACCES'),
    catalog: () => systemdCatalog(),
    locale: () => ({ messages: executor.identity.locale || 'C', utf8: /utf-?8/i.test(executor.identity.locale || '') }),
    updateCatalog: () => (userMgr.currentUid === 0 ? null : 'Operation not permitted'),
    diskUsageBytes: () => journald.usageBytes(),
  };
}
