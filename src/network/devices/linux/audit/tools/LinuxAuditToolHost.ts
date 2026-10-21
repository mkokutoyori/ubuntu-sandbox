import { simulationNowMs } from '@/network/core/SystemClock';

import type { LinuxCommandExecutor } from '../../LinuxCommandExecutor';
import { AUDITD_CONF_PATH, formatMessages, loadAuditdConfig } from '../daemon/AuditdConfig';
import { vfsAuditdConfigFs } from '../daemon/VfsAuditdConfigFs';
import { hostClock } from './AuditHostClock';
import type { AuditSearchHost, DateStyle } from './AuditToolHost';
import type { AuditLoginHost } from './AuditLoginHost';

const AUDIT_DEVICE = 0xfd00;

function dateStyleFor(lang: string): DateStyle {
  if (lang.startsWith('en_US')) return 'mdy4';
  if (lang.startsWith('fr_')) return 'dmy4';
  return 'mdy2';
}

export function auditToolHost(executor: LinuxCommandExecutor): AuditSearchHost {
  const { vfs, userMgr } = executor;
  const clock = hostClock(executor.identity.timezone || 'UTC');
  const lang = executor.identity.locale || 'C';
  return {
    readFile: (path) => vfs.readFile(path),
    isDirectory: (path) => vfs.getType(path) === 'directory',
    userName: (uid) => userMgr.getUserByUid(uid)?.username ?? null,
    groupName: (gid) => userMgr.getGroupByGid(gid)?.name ?? null,
    localTime: clock.localTime,
    mktime: clock.mktime,
    nowSec: () => Math.floor(simulationNowMs() / 1000),
    uptimeSec: () => parseFloat((vfs.readFile('/proc/uptime') ?? '0').split(' ')[0]) || 0,
    auditConfig: () => {
      const loaded = loadAuditdConfig(vfsAuditdConfigFs(vfs, userMgr, { uid: userMgr.currentUid, gids: [userMgr.currentGid] }), { configFile: AUDITD_CONF_PATH, allowLinks: false });
      const note = loaded.rc === 0 ? '' : `NOTE - using built-in logs: ${loaded.config.logFile}\n`;
      return { logFile: loaded.config.logFile, eoeTimeout: loaded.config.endOfEventTimeout, stderr: formatMessages(loaded.messages) + note };
    },
    dateStyle: () => dateStyleFor(lang),
    protocolName: (number) => {
      const found = executor.nss.lookup('protocols', (source) => source.getprotobynumber?.(number));
      return found.status === 'SUCCESS' && found.entry ? found.entry.name : null;
    },
    userUid: (name) => userMgr.getUser(name)?.uid ?? null,
    groupGid: (name) => userMgr.getGroup(name)?.gid ?? null,
    deviceAndInode: (path) => {
      const inode = vfs.resolveInode(path);
      return inode ? { dev: AUDIT_DEVICE, ino: inode.id } : null;
    },
    writeFile: (path, content) => {
      if (vfs.getType(path) === 'directory') return false;
      vfs.writeFile(path, content, 0, 0, 0o177);
      return true;
    },
  };
}

export function auditLoginHost(executor: LinuxCommandExecutor): AuditLoginHost {
  const base = auditToolHost(executor);
  return {
    ...base,
    writeFile: (path, content) => base.writeFile(executor.vfs.normalizePath(path, executor.getCwd()), content),
    uid: () => executor.userMgr.currentUid,
    passwdEntries: () => executor.userMgr.getAllUsers().map((user) => ({ name: user.username, uid: user.uid })),
  };
}
