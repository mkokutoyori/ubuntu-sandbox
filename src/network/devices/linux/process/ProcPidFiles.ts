import type { ProcessTask } from './ProcessTask';

const STATE_LABELS: Readonly<Record<string, string>> = {
  R: 'running',
  S: 'sleeping',
  D: 'disk sleep',
  T: 'stopped',
  t: 'tracing stop',
  Z: 'zombie',
  X: 'dead',
  I: 'idle',
};

export function environText(environ: Readonly<Record<string, string>>, separator: string, terminator = ''): string {
  const entries = Object.entries(environ).map(([name, value]) => `${name}=${value}`);
  return entries.length === 0 ? '' : entries.join(separator) + terminator;
}

function decimalMask(hex: string): string {
  return BigInt(`0x${hex}`).toString();
}

function kilobytes(value: number): string {
  return `${String(value).padStart(8, ' ')} kB`;
}

export function renderProcPidStat(task: ProcessTask, rssPages: number): string {
  const fields: (string | number)[] = [
    task.tid, `(${task.cmd})`, task.state, task.ppid, task.pgrp, task.session, task.tty, task.tpgid, task.flags,
    task.fltMin, 0, task.fltMaj, 0, task.ticsUser, task.ticsSystem, task.ticsUserC, task.ticsSystemC,
    task.priority, task.nice, task.nlwp, 0, task.ticsBegan, task.vsizeBytes, rssPages,
    task.rssRlim === Infinity ? '18446744073709551615' : task.rssRlim,
    task.addrCodeStart, task.addrCodeEnd, task.addrStackStart, task.addrCurrEsp, task.addrCurrEip,
    decimalMask(task.signals), decimalMask(task.sigBlocked), decimalMask(task.sigIgnore), decimalMask(task.sigCatch),
    0, 0, 0, 17, task.processor, task.priorityRt, task.schedClass, 0, 0, 0,
    task.addrCodeStart, task.addrCodeEnd, task.addrStackStart, task.addrStackStart, task.addrStackStart, task.addrStackStart, task.addrStackStart, 0,
  ];
  return `${fields.join(' ')}\n`;
}

export function renderProcPidStatus(task: ProcessTask, umask: number): string {
  const label = STATE_LABELS[task.state] ?? 'sleeping';
  const lines = [
    `Name:\t${task.cmd}`,
    `Umask:\t${umask.toString(8).padStart(4, '0')}`,
    `State:\t${task.state} (${label})`,
    `Tgid:\t${task.tgid}`,
    'Ngid:\t0',
    `Pid:\t${task.tid}`,
    `PPid:\t${task.ppid}`,
    'TracerPid:\t0',
    `Uid:\t${task.ruid}\t${task.euid}\t${task.suid}\t${task.fuid}`,
    `Gid:\t${task.rgid}\t${task.egid}\t${task.sgid}\t${task.fgid}`,
    'FDSize:\t256',
    `Groups:\t${task.supgids === '-' ? '' : task.supgids.split(',').join(' ')} `,
    `NStgid:\t${task.tgid}`,
    `NSpid:\t${task.tid}`,
    `NSpgid:\t${task.pgrp}`,
    `NSsid:\t${task.session}`,
  ];
  if (task.vmSize > 0) {
    lines.push(
      `VmPeak:\t${kilobytes(task.vmSize)}`,
      `VmSize:\t${kilobytes(task.vmSize)}`,
      `VmLck:\t${kilobytes(task.vmRssLocked)}`,
      'VmPin:\t       0 kB',
      `VmHWM:\t${kilobytes(task.vmRss)}`,
      `VmRSS:\t${kilobytes(task.vmRss)}`,
      `RssAnon:\t${kilobytes(Math.floor(task.vmRss / 3))}`,
      `RssFile:\t${kilobytes(task.vmRss - Math.floor(task.vmRss / 3))}`,
      'RssShmem:\t       0 kB',
      `VmData:\t${kilobytes(task.vmData)}`,
      `VmStk:\t${kilobytes(task.vmStack)}`,
      `VmExe:\t${kilobytes(task.vmExe)}`,
      `VmLib:\t${kilobytes(task.vmLib)}`,
      `VmPTE:\t${kilobytes(Math.max(8, Math.floor(task.vmSize / 100)))}`,
      'VmSwap:\t       0 kB',
      'HugetlbPages:\t       0 kB',
    );
  }
  lines.push(
    'CoreDumping:\t0',
    'THP_enabled:\t1',
    `Threads:\t${task.nlwp}`,
    'SigQ:\t0/31886',
    `SigPnd:\t${task.sigPending}`,
    'ShdPnd:\t0000000000000000',
    `SigBlk:\t${task.sigBlocked}`,
    `SigIgn:\t${task.sigIgnore}`,
    `SigCgt:\t${task.sigCatch}`,
    'CapInh:\t0000000000000000',
    `CapPrm:\t${task.euid === 0 ? '000001ffffffffff' : '0000000000000000'}`,
    `CapEff:\t${task.euid === 0 ? '000001ffffffffff' : '0000000000000000'}`,
    'CapBnd:\t000001ffffffffff',
    'CapAmb:\t0000000000000000',
    'NoNewPrivs:\t0',
    'Seccomp:\t0',
    'Seccomp_filters:\t0',
    'Speculation_Store_Bypass:\tthread vulnerable',
    'Cpus_allowed:\tf',
    'Cpus_allowed_list:\t0-3',
    'Mems_allowed:\t00000001',
    'Mems_allowed_list:\t0',
    'voluntary_ctxt_switches:\t0',
    'nonvoluntary_ctxt_switches:\t0',
  );
  return `${lines.join('\n')}\n`;
}

export function renderProcPidStatm(task: ProcessTask, pageKb: number): string {
  const size = Math.floor(task.vmSize / pageKb);
  const resident = Math.floor(task.vmRss / pageKb);
  return `${size} ${resident} ${Math.floor(resident / 2)} ${Math.floor(task.vmExe / pageKb)} 0 ${Math.floor(task.vmData / pageKb)} 0\n`;
}

export function renderProcPidCmdline(task: ProcessTask, command: string): string {
  if (task.state === 'Z' || command.startsWith('[') || command === '') return '';
  return `${command.split(/\s+/).join('\0')}\0`;
}
