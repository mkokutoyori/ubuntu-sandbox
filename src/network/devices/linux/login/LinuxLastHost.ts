import { simulationNowMs } from '@/network/core/SystemClock';
import type { LinuxCommandExecutor } from '../LinuxCommandExecutor';
import { hostClock } from '../audit/tools/AuditHostClock';
import type { LastFile, LastHost } from './LastTool';
import { binaryStringToBytes } from './UtmpxRecord';

export function lastHost(executor: LinuxCommandExecutor): LastHost {
  const { vfs, userMgr } = executor;
  return {
    openFile: (path): LastFile => {
      const absolute = vfs.normalizePath(path, executor.getCwd());
      const inode = vfs.resolveInode(absolute);
      if (!inode) return { kind: 'error', message: 'No such file or directory' };
      const groups = userMgr.getUserGroups(userMgr.currentUser).map((group) => group.gid);
      if (!vfs.checkAccess(inode, 'r', userMgr.currentUid, userMgr.currentGid, groups)) {
        return { kind: 'error', message: 'Permission denied' };
      }
      const ctime = Math.floor(inode.ctime / 1000);
      if (inode.type === 'directory') return { kind: 'directory', ctime };
      return { kind: 'file', bytes: binaryStringToBytes(vfs.readFile(absolute) ?? ''), ctime };
    },
    nowSec: () => Math.floor(simulationNowMs() / 1000),
    bootTimeSec: () => Math.floor((executor.lifecycle.bootedAt()?.getTime() ?? simulationNowMs()) / 1000),
    clock: hostClock(executor.identity.timezone || 'UTC'),
    userExists: (name) => {
      const user = userMgr.getUser(name);
      return user ? { uid: user.uid } : null;
    },
    loginUid: (pid) => {
      const content = vfs.readFile(`/proc/${pid}/loginuid`);
      if (content === null) return undefined;
      const value = /^\s*(\d+)/.exec(content);
      return value ? Number(value[1]) : null;
    },
    deviceOwner: (line) => vfs.resolveInode(`/dev/${line}`)?.uid ?? null,
    reverseName: () => null,
    utf8: () => /utf-?8/i.test(executor.identity.locale || ''),
  };
}
