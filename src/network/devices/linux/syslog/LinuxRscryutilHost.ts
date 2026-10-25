import type { LinuxCommandExecutor } from '../LinuxCommandExecutor';
import { latin1Bytes, latin1Text } from '@/network/rsyslog/engine/Latin1';
import type { RscryutilHost } from './RscryutilTool';

export function rscryutilHost(executor: LinuxCommandExecutor): RscryutilHost {
  const { vfs, userMgr } = executor;
  const readable = (path: string): { readonly absolute: string } | { readonly error: string } => {
    const absolute = vfs.normalizePath(path, executor.getCwd());
    const inode = vfs.resolveInode(absolute);
    if (!inode) return { error: 'No such file or directory' };
    const groups = userMgr.getUserGroups(userMgr.currentUser).map((group) => group.gid);
    if (!vfs.checkAccess(inode, 'r', userMgr.currentUid, userMgr.currentGid, groups)) return { error: 'Permission denied' };
    if (inode.type === 'directory') return { error: 'Is a directory' };
    return { absolute };
  };
  return {
    readBytes: (path) => {
      const found = readable(path);
      return 'error' in found ? found : { bytes: latin1Bytes(vfs.readFile(found.absolute) ?? '') };
    },
    readText: (path) => {
      const found = readable(path);
      return 'error' in found ? found : { text: vfs.readFile(found.absolute) ?? '' };
    },
    createKeyFile: (path, bytes, force) => {
      const absolute = vfs.normalizePath(path, executor.getCwd());
      if (vfs.resolveInode(absolute) !== null && !force) return 'File exists';
      if (!vfs.writeFile(absolute, latin1Text(bytes), userMgr.currentUid, userMgr.currentGid, 0o022)) return 'Permission denied';
      vfs.chmod(absolute, 0o400);
      return null;
    },
    randomBytes: (count) => crypto.getRandomValues(new Uint8Array(count)),
    runKeyProgram: (program) => {
      const result = executor.executeChild(`'${program.replace(/'/g, `'\\''`)}'`);
      return { output: result.output, exitCode: result.status };
    },
  };
}
