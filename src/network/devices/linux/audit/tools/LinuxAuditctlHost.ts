import type { LinuxCommandExecutor } from '../../LinuxCommandExecutor';
import { SIGNAL_NUMBERS, type Signal } from '../../LinuxProcessManager';
import { MACH } from './AuditctlLib';
import type { AuditctlHost } from './AuditctlTool';
import { auditToolHost } from './LinuxAuditToolHost';
import type { AugenrulesHost } from './AugenrulesTool';
import { runAuditctl } from './AuditctlTool';

const SYSLOG_PRIORITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

export function auditctlHost(executor: LinuxCommandExecutor, privileged: boolean): AuditctlHost {
  const { vfs, userMgr } = executor;
  const tool = auditToolHost(executor);
  return {
    userName: tool.userName,
    groupName: tool.groupName,
    protocolName: tool.protocolName,
    isRoot: () => privileged || userMgr.currentUid === 0,
    lookupUser: (name) => userMgr.getUser(name)?.uid ?? null,
    lookupGroup: (name) => userMgr.getGroup(name)?.gid ?? null,
    fileKind: (path) => {
      const type = vfs.getType(path);
      return type === null ? 'missing' : type === 'directory' ? 'directory' : type === 'file' ? 'file' : 'other';
    },
    readFile: (path) => vfs.readFile(path),
    kernel: () => executor.auditRules.kernel,
    detectMachine: () => MACH.X86_64,
    signalProcess: (pid, signal) => {
      const name = (Object.keys(SIGNAL_NUMBERS) as Signal[]).find((candidate) => SIGNAL_NUMBERS[candidate] === signal);
      if (name === undefined) return 0;
      return executor.processMgr.kill(pid, name) ? 0 : -1;
    },
    terminal: () => 'pts/0',
    syslog: (priority, text) => {
      executor.logMgr.logAt(`daemon.${SYSLOG_PRIORITIES[priority & 7]}`, 'auditctl', text);
    },
  };
}

export function augenrulesHost(executor: LinuxCommandExecutor): AugenrulesHost {
  const { vfs } = executor;
  return {
    listDirectory: (path) => vfs.listDirectory(path)?.filter((entry) => entry.inode.type === 'file').map((entry) => entry.name) ?? null,
    readFile: (path) => vfs.readFile(path),
    writeFile: (path, content, mode) => vfs.writeFile(path, content, 0, 0, (~mode) & 0o777),
    loadRules: (path) => runAuditctl(auditctlHost(executor, true), ['-R', path]),
  };
}

