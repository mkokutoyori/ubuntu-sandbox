import { simulationNowMs } from '@/network/core/SystemClock';
import type { LinuxCommandExecutor } from '../LinuxCommandExecutor';
import { hostClock } from '../audit/tools/AuditHostClock';
import { kernelHostname } from '../KernelHostname';
import type { LoggerHost, LoggerOpen } from './LoggerTool';

const UDP = 2;
const JOURNAL_SOCKETS = new Set(['/dev/log', '/run/systemd/journal/dev-log']);
const SYSLOG_PORT = 514;
const NOT_FOUND = { error: 'No such file or directory' } as const;

function resolveAddress(name: string, hosts: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return name.split('.').every((octet) => Number(octet) <= 255) ? name : null;
  for (const line of hosts.split('\n')) {
    const [address, ...names] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address ?? '') && names.includes(name)) return address;
  }
  return null;
}

function encodeNative(lines: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: number[] = [];
  for (const line of lines) {
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const name = encoder.encode(line.slice(0, equals));
    const value = encoder.encode(line.slice(equals + 1));
    if (!value.includes(10)) {
      parts.push(...encoder.encode(line), 10);
      continue;
    }
    const size = new Uint8Array(8);
    new DataView(size.buffer).setBigUint64(0, BigInt(value.length), true);
    parts.push(...name, 10, ...size, ...value, 10);
  }
  return Uint8Array.from(parts);
}

export function loggerHost(executor: LinuxCommandExecutor, stdinText: string | undefined, argv: string[]): LoggerHost {
  const { logMgr, userMgr, vfs } = executor;
  const pid = logMgr.allocatePid();
  const shellPid = executor.currentPid();
  const attrs = executor.auditAttributesOf(shellPid);
  const NONE = 4294967295;
  logMgr.registerProcessFacts(pid, {
    uid: userMgr.currentUid,
    gid: userMgr.currentGid,
    comm: 'logger',
    exe: '/usr/bin/logger',
    cmdline: ['logger', ...argv].join(' '),
    capeff: null,
    label: null,
    auditId: attrs.sessionid === NONE ? null : attrs.sessionid,
    loginUid: attrs.loginuid === NONE ? null : attrs.loginuid,
    cgroup: executor.cgroupPathFor(shellPid),
    invocationId: null,
  });
  const ucred = { pid, uid: userMgr.currentUid, gid: userMgr.currentGid };
  const open = (): LoggerOpen => ({
    type: UDP,
    connection: {
      send: (bytes) => {
        logMgr.journald.deliverSyslog(bytes, ucred);
        return null;
      },
      close: () => undefined,
    },
  });
  return {
    nowMicros: () => simulationNowMs() * 1000,
    clock: hostClock(executor.identity.timezone || 'UTC'),
    hostname: () => {
      const name = kernelHostname(vfs);
      return name.length > 255 ? null : name;
    },
    pid: () => pid,
    login: () => userMgr.currentUser,
    isRoot: () => userMgr.currentUid === 0,
    processExists: (candidate) => executor.processMgr.get(candidate) !== undefined,
    sdBooted: () => true,
    connectUnix: (path, types) => {
      if (!JOURNAL_SOCKETS.has(path)) return NOT_FOUND;
      return types & UDP ? open() : { error: 'Protocol wrong type for socket' };
    },
    connectInet: (server, port, types) => {
      const portName = port ?? 'syslog';
      const portNumber = portName === 'syslog' ? SYSLOG_PORT : /^\d+$/.test(portName) ? Number(portName) : null;
      const address = resolveAddress(server, vfs.readFile('/etc/hosts') ?? '');
      if (address === null || portNumber === null || portNumber > 65535) return { fatal: `failed to resolve name ${server} port ${portName}: ${address === null ? 'Name or service not known' : 'Servname not supported for ai_socktype'}` };
      if (!(types & UDP) || executor.datagramSender === null) return { error: 'Connection refused' };
      const sender = executor.datagramSender;
      return {
        type: UDP,
        connection: {
          send: (bytes) => (sender(address, portNumber, Uint8Array.from(bytes)) ? null : 'Network is unreachable'),
          close: () => undefined,
        },
      };
    },
    readFile: (path) => {
      const absolute = vfs.normalizePath(path, executor.getCwd());
      const inode = vfs.resolveInode(absolute);
      if (!inode) return NOT_FOUND;
      const groups = userMgr.getUserGroups(userMgr.currentUser).map((group) => group.gid);
      if (!vfs.checkAccess(inode, 'r', userMgr.currentUid, userMgr.currentGid, groups)) return { error: 'Permission denied' };
      if (inode.type === 'directory') return { error: 'Is a directory' };
      return { bytes: new TextEncoder().encode(vfs.readFile(absolute) ?? '') };
    },
    stdin: () => new TextEncoder().encode(stdinText ?? ''),
    journal: (lines) => {
      logMgr.journald.deliverNative(encodeNative(lines), ucred);
      return true;
    },
  };
}
