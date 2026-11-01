import { kernelComm } from '../LinuxProcessManager';
import { measuredFootprintOf } from './ProcessFootprint';
import type { LinuxProcess } from './LinuxProcess';
import type { ProcessTask } from './ProcessTask';

export const NAMESPACE_IDS: Readonly<Record<string, number>> = {
  cgroup: 4026531835,
  ipc: 4026531839,
  mnt: 4026531841,
  net: 4026531840,
  pid: 4026531836,
  time: 4026531834,
  user: 4026531837,
  uts: 4026531838,
};

export interface TaskFacts {
  readonly hertz: number;
  readonly bootEpochMs: number;
  readonly pageSizeBytes: number;
  readonly cpuCount: number;
  userName(uid: number): string | null;
  groupName(gid: number): string | null;
  supplementaryGroups(info: LinuxProcess): readonly number[];
  loginUid(pid: number): number;
  cgroupOf(pid: number): string;
  exeOf(pid: number): string | null;
  environOf(info: LinuxProcess): string | null;
  labelOf(pid: number): string;
  foregroundGroupOf(info: LinuxProcess): number;
}

const PF_FORKNOEXEC = 0x40;
const PF_SUPERPRIV = 0x100;
const PF_KTHREAD = 0x200000;
const PF_NO_SETAFFINITY = 0x04000000;
const RLIM_INFINITY = Infinity;
const PTY_MAJOR = 136;
const TTY_MAJOR = 4;

const LIGHTWEIGHT_COMMANDS: ReadonlySet<string> = new Set([
  'sleep', 'nc', 'ncat', 'bash', 'sh', 'dash', 'cat', 'tail', 'head', 'yes', 'sort', 'grep', 'sed', 'awk', 'cut', 'wc', 'tee', 'true', 'false', 'tr', 'less',
]);

const WAIT_CHANNELS: Readonly<Record<string, string>> = {
  sleep: 'hrtimer_nanosleep',
  bash: 'do_wait',
  sh: 'do_wait',
  dash: 'do_wait',
  su: 'do_wait',
  sudo: 'do_wait',
  nc: 'inet_csk_accept',
  ncat: 'inet_csk_accept',
  cron: 'hrtimer_nanosleep',
  atd: 'hrtimer_nanosleep',
  sshd: 'do_select',
  systemd: 'do_epoll_wait',
  init: 'do_epoll_wait',
  'systemd-journald': 'do_epoll_wait',
  'systemd-logind': 'do_epoll_wait',
  'systemd-networkd': 'do_epoll_wait',
  'systemd-resolved': 'do_epoll_wait',
  'dbus-daemon': 'do_epoll_wait',
  chronyd: 'do_epoll_wait',
  rsyslogd: 'do_sys_poll',
  auditd: 'do_select',
  tail: 'do_sys_poll',
  cat: 'wait_woken',
};

const DEVICES: ReadonlyArray<{ readonly prefix: string; readonly major: number; readonly base: number }> = [
  { prefix: 'pts/', major: PTY_MAJOR, base: 0 },
  { prefix: 'ttyS', major: TTY_MAJOR, base: 64 },
  { prefix: 'tty', major: TTY_MAJOR, base: 0 },
];

export function ttyDeviceNumber(name: string): number {
  for (const device of DEVICES) {
    if (!name.startsWith(device.prefix)) continue;
    const index = Number(name.slice(device.prefix.length));
    if (!Number.isInteger(index) || index < 0) return 0;
    const minor = device.base + index;
    return (device.major << 8) | (minor & 0xff) | ((minor & ~0xff) << 12);
  }
  return 0;
}

export function ttyNameOfDevice(device: number): string {
  if (device === 0) return '?';
  const major = (device >>> 8) & 0xfff;
  const minor = (device & 0xff) | ((device & 0xfff00000) >>> 12);
  if (major >= PTY_MAJOR && major <= PTY_MAJOR + 7) return `pts/${minor + (major - PTY_MAJOR) * 256}`;
  if (major === TTY_MAJOR) return minor < 64 ? `tty${minor}` : `ttyS${minor - 64}`;
  return '?';
}

function abbreviatedTty(name: string): string {
  return name.replace(/^tty(?=.)/, '').replace(/^pts\/(?=.)/, '');
}

function isKernelThread(info: LinuxProcess): boolean {
  return info.command.startsWith('[');
}

function schedulingClass(policy: string): number {
  switch (policy) {
    case 'SCHED_FIFO': return 1;
    case 'SCHED_RR': return 2;
    case 'SCHED_BATCH': return 3;
    case 'SCHED_IDLE': return 5;
    case 'SCHED_DEADLINE': return 6;
    default: return 0;
  }
}

function waitChannelOf(info: LinuxProcess, comm: string): string {
  if (info.wchan !== '0') return info.wchan;
  switch (info.state) {
    case 'R':
    case 'Z':
      return '0';
    case 'T':
      return 'do_signal_stop';
    case 'D':
      return 'io_schedule';
    default:
      if (isKernelThread(info)) return info.state === 'I' ? 'worker_thread' : 'smpboot_thread_fn';
      return WAIT_CHANNELS[comm] ?? 'do_sys_poll';
  }
}

export function lookupWaitChannel(raw: string): string {
  if (raw === '' || raw === '0') return '-';
  return raw.replace(/^\.?_*/, '');
}

export function buildTask(info: LinuxProcess, facts: TaskFacts): ProcessTask {
  const comm = kernelComm(info.comm);
  const kernelThread = isKernelThread(info);
  const zombie = info.state === 'Z';
  const ttyNr = ttyDeviceNumber(info.tty);
  const ticks = Math.floor(info.cpuTime / (1000 / facts.hertz));
  const started = Math.max(0, Math.round(((info.startTime.getTime() - facts.bootEpochMs) / 1000) * facts.hertz));
  const supplementary = facts.supplementaryGroups(info);
  const name = (id: number, lookup: (id: number) => string | null): string => lookup(id) ?? String(id);
  const userOf = (id: number): string => (id === info.uid ? info.user : name(id, facts.userName));
  const euid = info.euid;
  const privileged = euid === 0 && (!LIGHTWEIGHT_COMMANDS.has(comm) || info.command.startsWith('-'));
  let flags = 0;
  if (kernelThread) flags |= PF_KTHREAD | PF_NO_SETAFFINITY | PF_FORKNOEXEC;
  if (info.forkedNoExec) flags |= PF_FORKNOEXEC;
  if (privileged && !kernelThread) flags |= PF_SUPERPRIV;
  const cmdline = kernelThread ? info.command : zombie || info.command === '' ? `[${comm}]${zombie ? ' <defunct>' : ''}` : info.command;
  const cgroup = facts.cgroupOf(info.pid);
  const vsizeKb = zombie || kernelThread ? 0 : info.vsize;
  const rssKb = zombie || kernelThread ? 0 : info.rss;
  const environ = facts.environOf(info);
  const measured = vsizeKb === 0 ? undefined : measuredFootprintOf(info.comm);
  const textKb = vsizeKb === 0 ? 0 : measured?.text ?? Math.max(4, Math.floor(vsizeKb / 12));
  const codeStart = vsizeKb === 0 ? 0 : 0x55d0c0000000 + (info.pid % 64) * 0x10000;
  const wchan = waitChannelOf(info, comm);
  const sigBlocked = comm === 'bash' || comm === 'sh' ? '0000000000010000' : '0000000000000000';
  const stackStart = 0x7ffc00000000 + (info.pid % 4096) * 0x1000;
  return {
    tid: info.pid,
    tgid: info.pid,
    ppid: info.ppid,
    pgrp: info.pgid,
    session: info.sid,
    tpgid: ttyNr === 0 ? -1 : facts.foregroundGroupOf(info),
    state: info.state,
    cmd: comm,
    cmdline,
    environ: environ === null || environ === '' ? '-' : environ,
    exe: facts.exeOf(info.pid) ?? '-',
    cgroup: cgroup === '' ? '-' : cgroup,
    cgname: cgroup.split('/').filter(Boolean).pop() ?? '-',
    lxcname: '-',
    ruid: info.uid,
    euid,
    suid: info.suid,
    fuid: info.fsuid,
    rgid: info.gid,
    egid: info.egid,
    sgid: info.sgid,
    fgid: info.fsgid,
    ruser: userOf(info.uid),
    euser: userOf(euid),
    suser: userOf(info.suid),
    fuser: userOf(info.fsuid),
    rgroup: name(info.gid, facts.groupName),
    egroup: name(info.egid, facts.groupName),
    sgroup: name(info.sgid, facts.groupName),
    fgroup: name(info.fsgid, facts.groupName),
    supgids: supplementary.length === 0 ? '-' : supplementary.join(','),
    supgrps: supplementary.length === 0 ? '-' : supplementary.map((gid) => name(gid, facts.groupName)).join(','),
    luid: facts.loginUid(info.pid),
    tty: ttyNr,
    ttyName: ttyNameOfDevice(ttyNr),
    ttyNumber: abbreviatedTty(ttyNameOfDevice(ttyNr)),
    flags,
    nice: info.nice,
    priority: info.priority,
    priorityRt: info.rtPriority,
    schedClass: schedulingClass(info.schedPolicy),
    nlwp: zombie ? 0 : info.numThreads,
    processor: info.pid % Math.max(1, facts.cpuCount),
    processorNode: 0,
    ticsUser: ticks,
    ticsSystem: 0,
    ticsUserC: 0,
    ticsSystemC: 0,
    ticsBegan: started,
    vmSize: vsizeKb,
    vmRss: rssKb,
    vmRssLocked: 0,
    vmData: Math.floor(vsizeKb / 8),
    vmStack: vsizeKb === 0 ? 0 : 132,
    vmExe: textKb,
    vmLib: vsizeKb === 0 ? 0 : Math.floor(vsizeKb / 3),
    vsizeBytes: vsizeKb * 1024,
    rssPages: Math.floor(rssKb / (facts.pageSizeBytes / 1024)),
    rssRlim: info.rsslim < 0 ? RLIM_INFINITY : info.rsslim,
    fltMin: measured?.minorFaults ?? Math.floor(rssKb / 4),
    fltMinC: measured?.minorFaults ?? Math.floor(rssKb / 4),
    fltMaj: 0,
    fltMajC: 0,
    addrCodeStart: codeStart,
    addrCodeEnd: vsizeKb === 0 ? 0 : codeStart + textKb * 1024,
    addrStackStart: vsizeKb === 0 ? 0 : stackStart,
    addrCurrEsp: 0,
    addrCurrEip: 0,
    sigBlocked,
    sigCatch: kernelThread ? '0000000000000000' : '0000000000010002',
    sigIgnore: kernelThread ? 'ffffffffffffffff' : '0000000000000006',
    signals: '0000000000000000',
    sigPending: '0000000000000000',
    wchanName: lookupWaitChannel(wchan),
    ioReadBytes: info.ioReadBytes,
    ioReadChars: info.ioRead > 0 ? info.ioRead : measured?.readChars ?? 0,
    ioReadOps: 0,
    ioWriteBytes: info.ioWriteBytes,
    ioWriteCBytes: 0,
    ioWriteChars: info.ioWrite,
    ioWriteOps: 0,
    nsCgroup: NAMESPACE_IDS.cgroup,
    nsIpc: NAMESPACE_IDS.ipc,
    nsMnt: NAMESPACE_IDS.mnt,
    nsNet: NAMESPACE_IDS.net,
    nsPid: NAMESPACE_IDS.pid,
    nsTime: NAMESPACE_IDS.time,
    nsUser: NAMESPACE_IDS.user,
    nsUts: NAMESPACE_IDS.uts,
    oomAdj: 0,
    oomScore: info.oomScore,
    autogroupId: info.sid,
    autogroupNice: 0,
    smapPss: measured?.pss ?? Math.floor(rssKb / 2),
    smapPrivateTotal: measured?.uss ?? Math.floor(rssKb / 3),
    sdMach: '-',
    sdOuid: '-',
    sdSeat: '-',
    sdSess: '-',
    sdSlice: '-',
    sdUnit: '-',
    sdUunit: '-',
    label: facts.labelOf(info.pid),
  };
}

