import { simulationNowMs } from '@/network/core/SystemClock';
import type { LinuxCommandExecutor } from '../LinuxCommandExecutor';
import { hostClock } from '../audit/tools/AuditHostClock';
import { parseAccountDatabase } from '../iam/fs/AccountDatabaseParser';
import { LASTLOG_PATH } from '../LinuxLastlogRegistry';
import type { LastlogFile, LastlogHost } from './LastlogTool';
import { binaryStringToBytes, bytesToBinaryString } from './UtmpxRecord';

export function lastlogHost(executor: LinuxCommandExecutor): LastlogHost {
  const { vfs, userMgr } = executor;
  let root = '';
  const inRoot = (path: string): string => `${root}${path}`;
  return {
    nowSec: () => Math.floor(simulationNowMs() / 1000),
    clock: hostClock(executor.identity.timezone || 'UTC'),
    passwd: () => {
      if (root === '') return userMgr.getAllUsers().map((user) => ({ name: user.username, uid: user.uid }));
      const text = vfs.readFile(inRoot('/etc/passwd')) ?? '';
      return parseAccountDatabase({ passwd: text, shadow: '', group: '', gshadow: '' }, { users: [], groups: [] })
        .users.map((user) => ({ name: user.username, uid: user.uid }));
    },
    loginDefs: () => vfs.readFile(inRoot('/etc/login.defs')),
    openLastlog: (write): LastlogFile => {
      const inode = vfs.resolveInode(inRoot(LASTLOG_PATH));
      if (!inode) return { kind: 'error', message: 'No such file or directory' };
      const groups = userMgr.getUserGroups(userMgr.currentUser).map((group) => group.gid);
      if (!vfs.checkAccess(inode, 'r', userMgr.currentUid, userMgr.currentGid, groups)
        || (write && !vfs.checkAccess(inode, 'w', userMgr.currentUid, userMgr.currentGid, groups))) {
        return { kind: 'error', message: 'Permission denied' };
      }
      return { kind: 'file', bytes: binaryStringToBytes(vfs.readFile(inRoot(LASTLOG_PATH)) ?? '') };
    },
    writeLastlog: (bytes) => vfs.writeFile(inRoot(LASTLOG_PATH), bytesToBinaryString(bytes), 0, 0, 0o022),
    changeRoot: (directory) => {
      if (userMgr.currentUid !== 0) return `unable to chroot to directory ${directory}: Operation not permitted`;
      root = directory.replace(/\/+$/, '');
      return null;
    },
    directoryExists: (directory) => vfs.getType(directory) === 'directory',
  };
}
