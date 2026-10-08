import { simulationNowMs } from '@/network/core/SystemClock';

import type { LinuxCommandExecutor } from '../../LinuxCommandExecutor';
import { AUDIT_PATHS } from '../LinuxAuditLog';
import { hostClock } from './AuditHostClock';
import type { AuditSearchHost, DateStyle } from './AuditToolHost';

function parseAuditdConf(text: string): { logFile: string; eoeTimeout: number } {
  let logFile: string = AUDIT_PATHS.log;
  let eoeTimeout = 2;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#') || line === '') continue;
    const match = /^([a-z_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === 'log_file') logFile = match[2].trim();
    else if (match[1] === 'end_of_event_timeout') eoeTimeout = parseInt(match[2], 10) || 2;
  }
  return { logFile, eoeTimeout };
}

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
      const conf = vfs.readFile(AUDIT_PATHS.config);
      return conf === null ? null : parseAuditdConf(conf);
    },
    dateStyle: () => dateStyleFor(lang),
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
