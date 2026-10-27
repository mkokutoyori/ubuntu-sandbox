import type { BrokenDownTime } from '../../../logrotate/CalendarTime';
import type { PsHost } from './PsHost';
import type { PsState } from './PsState';
import type { ProcessTask } from '../../../process/ProcessTask';
import { OUTBUF_SIZE } from './PsTypes';

export interface PrintContext {
  readonly state: PsState;
  readonly host: PsHost;
  maxRightward: number;
  wideSignals: boolean;
  readonly bootTics: number;
}

export type Printer = (context: PrintContext, task: ProcessTask) => string;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SIGNAL_NAMES = [
  '', 'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD',
  'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'IO', 'PWR', 'SYS',
];
const SIGRTMIN = 34;
const SIGRTMAX = 64;
const NSIG = 65;

function pad(value: number, width: number, fill = '0'): string {
  return String(value).padStart(width, fill);
}

function ctime(local: BrokenDownTime): string {
  return `${WEEKDAYS[local.weekday]} ${MONTHS[local.month]} ${pad(local.day, 2, ' ')} ${pad(local.hour, 2)}:${pad(local.minute, 2)}:${pad(local.second, 2)} ${local.year}\n`;
}

const CONTROL_REPLACEMENT = '.';

export interface EscapedText {
  readonly text: string;
  readonly cells: number;
}

export function escapeString(source: string, maxCells: number, utf8: boolean): EscapedText {
  if (maxCells <= 0) return { text: '', cells: 0 };
  let text = '';
  let cells = 0;
  for (const character of source) {
    if (cells >= maxCells || text.length + 1 >= OUTBUF_SIZE) break;
    const code = character.codePointAt(0) as number;
    if (code === 0) break;
    if (utf8) {
      text += code >= 32 && code < 127 ? character : code >= 160 ? character : '?';
    } else if (code < 32 || code === 127) {
      text += CONTROL_REPLACEMENT;
    } else if (code >= 128) {
      text += '?';
    } else {
      text += character;
    }
    cells++;
  }
  return { text, cells };
}

function forestHelper(context: PrintContext): string {
  const prefix = context.state.forestPrefix;
  if (prefix === '') return '';
  let rightward = context.maxRightward < OUTBUF_SIZE ? context.maxRightward : OUTBUF_SIZE - 1;
  let out = '';
  const unixy = context.state.forestType === 'u';
  for (const mark of prefix) {
    if (unixy) {
      if (rightward < 2) break;
      out += '  ';
      rightward -= 2;
    } else {
      if (rightward < 4) break;
      out += mark === ' ' ? '    ' : mark === '|' ? ' |  ' : ' \\_ ';
      rightward -= 4;
    }
  }
  return out;
}

function cellsLimited(context: PrintContext, text: string, used: number): string {
  const room = Math.max(0, context.maxRightward - used);
  return escapeString(text, room, context.host.utf8).text;
}

function commandPrinter(pick: (task: ProcessTask, context: PrintContext) => string): Printer {
  return (context, task) => {
    const forest = forestHelper(context);
    let rightward = context.maxRightward - forest.length;
    const first = escapeString(pick(task, context), rightward, context.host.utf8);
    let text = forest + first.text;
    rightward -= first.cells;
    if (context.state.bsdEOption && rightward > 1) {
      const environment = task.environ;
      if (environment !== '-') {
        text += ' ';
        rightward--;
        text += escapeString(environment, rightward, context.host.utf8).text;
      }
    }
    return text;
  };
}

function seconds(ticks: number, hertz: number): number {
  return Math.floor(ticks / hertz);
}

function elapsedSeconds(context: PrintContext, task: ProcessTask): number {
  const delta = context.bootTics - task.ticsBegan;
  return delta > 0 ? delta / context.host.hertz : 0;
}

function totalTicks(context: PrintContext, task: ProcessTask): number {
  return context.state.includeDeadChildren ? task.ticsUser + task.ticsSystem + task.ticsUserC + task.ticsSystemC : task.ticsUser + task.ticsSystem;
}

function cpuTimeSeconds(task: ProcessTask, hertz: number): number {
  return Math.floor((task.ticsUser + task.ticsSystem) / hertz);
}

function splitTime(total: number): { dd: number; hh: number; mm: number; ss: number } {
  const ss = total % 60;
  const minutes = Math.floor(total / 60);
  const mm = minutes % 60;
  const hours = Math.floor(minutes / 60);
  return { dd: Math.floor(hours / 24), hh: hours % 24, mm, ss };
}

function percentCpu(context: PrintContext, task: ProcessTask, scale: number): number {
  const jiffies = Math.floor(elapsedSeconds(context, task) * context.host.hertz);
  return jiffies > 0 ? Math.floor((totalTicks(context, task) * scale) / jiffies) : 0;
}

function userName(context: PrintContext, name: string, id: number): string {
  if (!context.state.userIsNumber) {
    const escaped = escapeString(name, OUTBUF_SIZE, context.host.utf8).text;
    if (escaped.length <= context.maxRightward) return escaped;
    if (context.maxRightward >= 1 && escaped.charCodeAt(context.maxRightward - 1) < 127) return `${escaped.slice(0, context.maxRightward - 1)}+`;
  }
  return String(id >>> 0);
}

function namespace(value: number): string {
  return value ? String(value) : '-';
}

function signalColumn(context: PrintContext, signal: string): string {
  if (context.state.signalNames) {
    const named = signalNames(signal, context.maxRightward);
    if (named !== null) return named;
  }
  const length = signal.length;
  if (context.wideSignals) {
    if (length > 8) return signal;
    return `00000000${signal}`;
  }
  const leading = /^0*/.exec(signal)?.[0].length ?? 0;
  if (length - leading > 8) return `<${signal.slice(length - 8)}`;
  if (length < 8) return `${'00000000'.slice(length)}${signal}`;
  return signal.slice(length - 8);
}

function signalAbbreviation(number: number): string {
  if (number === 0 || number >= NSIG) return `BOGUS_${pad(number - 65, 2)}`;
  if (number < 32 && SIGNAL_NAMES[number] !== undefined && SIGNAL_NAMES[number] !== '') return SIGNAL_NAMES[number];
  if (number >= SIGRTMIN) {
    if (number === SIGRTMIN) return 'RTMIN';
    if (number === SIGRTMAX) return 'RTMAX';
    return `RTMIN+${pad(number - SIGRTMIN, 2)}`;
  }
  return `LIBC+${pad(number - 32, 2)}`;
}

function signalNames(signal: string, length: number): string | null {
  if (!/^\d+/.test(signal)) return null;
  const mask = BigInt(/^\d+/.exec(signal)![0]);
  let text = '';
  let remaining = length;
  for (let number = 1; number < NSIG; number++) {
    if ((mask & (1n << BigInt(number - 1))) === 0n) continue;
    const name = signalAbbreviation(number);
    if (name.length + 1 >= remaining) {
      text += '+';
      remaining -= 1;
      break;
    }
    const piece = text === '' ? name : `,${name}`;
    text += piece;
    remaining -= piece.length;
  }
  return text === '' ? '-' : text;
}

function hex16(value: number): string {
  return Math.trunc(value).toString(16).padStart(16, '0');
}

function priorityValue(task: ProcessTask): number {
  return task.priority;
}

export const PRINTERS: Readonly<Record<string, Printer>> = {
  nop: () => '-',
  agid: (_, t) => String(t.autogroupId),
  agnice: (_, t) => String(t.autogroupNice),
  args: commandPrinter((t, c) => (c.state.bsdCOption ? t.cmd : t.cmdline)),
  comm: commandPrinter((t, c) => (c.state.unixFOption ? t.cmdline : t.cmd)),
  bsdstart: (c, t) => {
    const start = c.host.bootTimeSeconds + Math.floor(t.ticsBegan / c.host.hertz);
    const ago = Math.max(0, c.host.nowSeconds - start);
    const text = ctime(c.host.localTime(start));
    return (ago > 3600 * 24 ? text.slice(4) : text.slice(10)).slice(0, 6);
  },
  bsdtime: (c, t) => {
    const total = Math.floor(totalTicks(c, t) / c.host.hertz);
    return `${String(Math.floor(total / 60)).padStart(3, ' ')}:${pad(total % 60, 2)}`;
  },
  c: (c, t) => {
    const jiffies = Math.floor(elapsedSeconds(c, t) * c.host.hertz);
    let percent = jiffies > 0 ? Math.floor((totalTicks(c, t) * 100) / jiffies) : 0;
    if (percent > 99) percent = 99;
    return String(percent).padStart(2, ' ');
  },
  cgname: (c, t) => cellsLimited(c, t.cgname, 0),
  cgroup: (c, t) => cellsLimited(c, t.cgroup, 0),
  class: (_, t) => {
    switch (t.schedClass) {
      case -1: return '-';
      case 0: return 'TS';
      case 1: return 'FF';
      case 2: return 'RR';
      case 3: return 'B';
      case 4: return 'ISO';
      case 5: return 'IDL';
      case 6: return 'DLN';
      case 7: return '#7';
      case 8: return '#8';
      case 9: return '#9';
      default: return '?';
    }
  },
  context: (_, t) => t.label,
  cp: (c, t) => String(Math.min(percentCpu(c, t, 1000), 999)).padStart(3, ' '),
  drs: (_, t) => String(t.vsizeBytes ? Math.floor((t.vsizeBytes - t.addrCodeEnd + t.addrCodeStart) / 1024) : 0),
  dsiz: (_, t) => String(t.vsizeBytes ? Math.floor((t.vsizeBytes - t.addrCodeEnd + t.addrCodeStart) / 1024) : 0),
  egid: (_, t) => String(t.egid | 0),
  egroup: (c, t) => userName(c, t.egroup, t.egid),
  eip: (_, t) => hex16(t.addrCurrEip),
  esp: (_, t) => hex16(t.addrCurrEsp),
  etime: (c, t) => {
    const { dd, hh, mm, ss } = splitTime(Math.floor(elapsedSeconds(c, t)));
    return `${dd ? `${dd}-` : ''}${dd || hh ? `${pad(hh, 2)}:` : ''}${pad(mm, 2)}:${pad(ss, 2)}`;
  },
  etimes: (c, t) => String(Math.floor(elapsedSeconds(c, t))),
  euid: (_, t) => String(t.euid | 0),
  euser: (c, t) => userName(c, t.euser, t.euid),
  exe: (c, t) => cellsLimited(c, t.exe, 0),
  fgid: (_, t) => String(t.fgid | 0),
  fgroup: (c, t) => userName(c, t.fgroup, t.fgid),
  flag: (_, t) => (Math.floor(t.flags / 64) & 7).toString(8),
  fname: (c, t) => {
    const forest = forestHelper(c);
    const room = Math.min(c.maxRightward - forest.length, 8);
    return forest + escapeString(t.cmd, room, c.host.utf8).text;
  },
  fuid: (_, t) => String(t.fuid | 0),
  fuser: (c, t) => userName(c, t.fuser, t.fuid),
  ipcns: (_, t) => namespace(t.nsIpc),
  cgroupns: (_, t) => namespace(t.nsCgroup),
  mntns: (_, t) => namespace(t.nsMnt),
  netns: (_, t) => namespace(t.nsNet),
  pidns: (_, t) => namespace(t.nsPid),
  timens: (_, t) => namespace(t.nsTime),
  userns: (_, t) => namespace(t.nsUser),
  utsns: (_, t) => namespace(t.nsUts),
  lim: (_, t) => (t.rssRlim === Infinity ? 'xx' : String(Math.floor(t.rssRlim / 1024)).padStart(5, ' ')),
  lstart: (c, t) => {
    const start = c.host.bootTimeSeconds + Math.floor(t.ticsBegan / c.host.hertz);
    return c.host.formatTime(c.state.lstartFormat ?? '%a %b %e %H:%M:%S %Y', start);
  },
  luid: (_, t) => (t.luid === -1 || t.luid === 0xffffffff ? '-' : String(t.luid)),
  lxcname: (_, t) => t.lxcname,
  majflt: (c, t) => String(c.state.includeDeadChildren ? t.fltMajC : t.fltMaj),
  minflt: (c, t) => String(c.state.includeDeadChildren ? t.fltMinC : t.fltMin),
  nice: (_, t) => (t.schedClass !== 0 && t.schedClass !== 3 && t.schedClass !== -1 ? '-' : String(t.nice)),
  nlwp: (_, t) => String(t.nlwp),
  numa: (_, t) => String(t.processorNode),
  oom: (_, t) => String(t.oomScore),
  oom_adj: (_, t) => String(t.oomAdj),
  opri: (_, t) => String(60 + priorityValue(t)),
  pcpu: (c, t) => {
    const percent = percentCpu(c, t, 1000);
    if (percent > 999) return String(Math.floor(percent / 10));
    return `${Math.floor(percent / 10)}.${percent % 10}`;
  },
  pgid: (_, t) => String(t.pgrp >>> 0),
  pmem: (c, t) => {
    let permille = Math.floor((t.vmRss * 1000) / c.host.memoryTotalKb);
    if (permille > 999) permille = 999;
    return `${String(Math.floor(permille / 10)).padStart(2, ' ')}.${permille % 10}`;
  },
  ppid: (_, t) => String(t.ppid >>> 0),
  pri: (_, t) => String(39 - t.priority),
  pri_api: (_, t) => String(-1 - t.priority),
  pri_bar: (_, t) => String(t.priority + 1),
  pri_baz: (_, t) => String(t.priority + 100),
  pri_foo: (_, t) => String(t.priority - 20),
  priority: (_, t) => String(t.priority),
  procs: (_, t) => String(t.tgid),
  psr: (_, t) => String(t.processor),
  pss: (_, t) => String(t.smapPss),
  rbytes: (_, t) => String(t.ioReadBytes),
  rchars: (_, t) => String(t.ioReadChars),
  rgid: (_, t) => String(t.rgid | 0),
  rgroup: (c, t) => userName(c, t.rgroup, t.rgid),
  rops: (_, t) => String(t.ioReadOps),
  rss: (_, t) => String(t.vmRss),
  rtprio: (_, t) => (t.schedClass === 0 || t.schedClass === -1 ? '-' : String(t.priorityRt)),
  ruid: (_, t) => String(t.ruid | 0),
  ruser: (c, t) => userName(c, t.ruser, t.ruid),
  s: (_, t) => t.state.slice(0, 1),
  sched: (_, t) => (t.schedClass === -1 ? '-' : String(t.schedClass)),
  sd_machine: (_, t) => t.sdMach,
  sd_ouid: (_, t) => t.sdOuid,
  sd_seat: (_, t) => t.sdSeat,
  sd_session: (_, t) => t.sdSess,
  sd_slice: (_, t) => t.sdSlice,
  sd_unit: (_, t) => t.sdUnit,
  sd_uunit: (_, t) => t.sdUunit,
  sess: (_, t) => String(t.session),
  sgi_p: (_, t) => (t.state === 'R' ? String(t.processor >>> 0) : '*'),
  sgid: (_, t) => String(t.sgid | 0),
  sgroup: (c, t) => userName(c, t.sgroup, t.sgid),
  sig: (c, t) => signalColumn(c, t.signals),
  sigcatch: (c, t) => signalColumn(c, t.sigCatch),
  sigignore: (c, t) => signalColumn(c, t.sigIgnore),
  sigmask: (c, t) => signalColumn(c, t.sigBlocked),
  tsig: (c, t) => signalColumn(c, t.sigPending),
  size: (_, t) => String(t.vsizeBytes),
  swapable: (_, t) => String(t.vmData + t.vmStack),
  stackp: (_, t) => hex16(t.addrStackStart),
  start: (c, t) => {
    const start = c.host.bootTimeSeconds + Math.floor(t.ticsBegan / c.host.hertz);
    const text = ctime(c.host.localTime(start)).split('');
    if (text[8] === ' ') text[8] = '0';
    if (text[11] === ' ') text[11] = '0';
    const line = text.join('');
    if (start + 60 * 60 * 24 > c.host.nowSeconds) return line.slice(11, 19);
    return `  ${line.slice(4, 10)}`;
  },
  stat: (_, t) => {
    let out = t.state.slice(0, 1);
    if (t.nice < 0) out += '<';
    if (t.nice > 0) out += 'N';
    if (t.vmRssLocked) out += 'L';
    if (t.session === t.tgid) out += 's';
    if (t.nlwp > 1) out += 'l';
    if (t.pgrp === t.tpgid) out += '+';
    return out;
  },
  stime: (c, t) => {
    const start = c.host.bootTimeSeconds + Math.floor(t.ticsBegan / c.host.hertz);
    const now = c.host.localTime(c.host.nowSeconds);
    const local = c.host.localTime(start);
    let format = '%H:%M';
    if (local.year !== now.year || local.month * 31 + local.day !== now.month * 31 + now.day) format = '%b%d';
    if (local.year !== now.year) format = '%Y';
    return c.host.formatTime(format, start);
  },
  suid: (_, t) => String(t.suid | 0),
  supgid: (_, t) => t.supgids,
  supgrp: (c, t) => cellsLimited(c, t.supgrps, 0),
  suser: (c, t) => userName(c, t.suser, t.suid),
  sz: (c, t) => String(Math.floor(t.vmSize / (c.host.pageSizeBytes / 1024))),
  tasks: (_, t) => String(t.tid),
  time: (c, t) => {
    const { dd, hh, mm, ss } = splitTime(cpuTimeSeconds(t, c.host.hertz));
    return `${dd ? `${dd}-` : ''}${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}`;
  },
  times: (c, t) => String(cpuTimeSeconds(t, c.host.hertz)),
  tpgid: (_, t) => String(t.tpgid),
  trs: (_, t) => String(t.vsizeBytes ? Math.floor((t.addrCodeEnd - t.addrCodeStart) / 1024) : 0),
  tsiz: (_, t) => String(t.vsizeBytes ? Math.floor((t.addrCodeEnd - t.addrCodeStart) / 1024) : 0),
  tty4: (_, t) => t.ttyNumber,
  tty8: (_, t) => t.ttyName,
  utilization: (c, t) => {
    const delta = c.bootTics - t.ticsBegan;
    let value = delta > 0 ? ((t.ticsUser + t.ticsSystem) * 100) / delta : 0;
    if (value > 99) value = 99.999;
    return value.toFixed(3);
  },
  utilization_c: (c, t) => {
    const delta = c.bootTics - t.ticsBegan;
    let value = delta > 0 ? ((t.ticsUser + t.ticsSystem + t.ticsUserC + t.ticsSystemC) * 100) / delta : 0;
    if (value > 99) value = 99.999;
    return value.toFixed(3);
  },
  uss: (_, t) => String(t.smapPrivateTotal),
  vsz: (_, t) => String(t.vmSize),
  wbytes: (_, t) => String(t.ioWriteBytes),
  wcbytes: (_, t) => String(t.ioWriteCBytes),
  wchan: (c, t) => t.wchanName.slice(0, Math.max(0, c.maxRightward)),
  wchars: (_, t) => String(t.ioWriteChars),
  wops: (_, t) => String(t.ioWriteOps),
  t_unlimited: (c) => ['[123456789-12345] <defunct>', 'ps', '123456789-123456'][((c.state.linesToNextHeader % 3) + 3) % 3].slice(0, c.maxRightward),
  t_unlimited2: (c) => ['unlimited', '[123456789-12345] <defunct>', 'ps', '123456789-123456'][((c.state.linesToNextHeader % 4) + 4) % 4].slice(0, c.maxRightward),
  t_right: (c) => ['999-23:59:59', '99-23:59:59', '9-23:59:59', '59:59'][((c.state.linesToNextHeader % 4) + 4) % 4],
  t_right2: (c) => ['999-23:59:59', '99-23:59:59', '9-23:59:59'][((c.state.linesToNextHeader % 3) + 3) % 3],
  t_left: (c) => ['tty7', 'pts/9999', 'iseries/vtty42', 'ttySMX0', '3270/tty4'][((c.state.linesToNextHeader % 5) + 5) % 5],
  t_left2: (c) => ['tty7', 'pts/9999', 'ttySMX0', '3270/tty4'][((c.state.linesToNextHeader % 4) + 4) % 4],
};

export type SortValue = number | string;
export type SortKind = 'number' | 'unsigned' | 'string' | 'noop';

export interface SortItem {
  readonly kind: SortKind;
  value(task: ProcessTask, context: SortContext): SortValue;
}

export interface SortContext {
  readonly hertz: number;
  readonly bootTics: number;
}

function item(kind: SortKind, value: (task: ProcessTask, context: SortContext) => SortValue): SortItem {
  return { kind, value };
}

function utilization(task: ProcessTask, context: SortContext): number {
  const delta = context.bootTics - task.ticsBegan;
  return delta > 0 ? ((task.ticsUser + task.ticsSystem) * 100) / delta : 0;
}

export const SORT_ITEMS: Readonly<Record<string, SortItem>> = {
  noop: item('noop', () => 0),
  ADDR_CODE_END: item('unsigned', (t) => t.addrCodeEnd),
  ADDR_CODE_START: item('unsigned', (t) => t.addrCodeStart),
  ADDR_CURR_EIP: item('unsigned', (t) => t.addrCurrEip),
  ADDR_CURR_ESP: item('unsigned', (t) => t.addrCurrEsp),
  ADDR_STACK_START: item('unsigned', (t) => t.addrStackStart),
  AUTOGRP_ID: item('number', (t) => t.autogroupId),
  AUTOGRP_NICE: item('number', (t) => t.autogroupNice),
  CGNAME: item('string', (t) => t.cgname),
  CGROUP: item('string', (t) => t.cgroup),
  CMD: item('string', (t) => t.cmd),
  CMDLINE: item('string', (t) => t.cmdline),
  EXE: item('string', (t) => t.exe),
  FLAGS: item('unsigned', (t) => t.flags),
  FLT_MAJ: item('unsigned', (t) => t.fltMaj),
  FLT_MIN: item('unsigned', (t) => t.fltMin),
  ID_EGID: item('unsigned', (t) => t.egid >>> 0),
  ID_EGROUP: item('string', (t) => t.egroup),
  ID_EUID: item('unsigned', (t) => t.euid >>> 0),
  ID_EUSER: item('string', (t) => t.euser),
  ID_FGID: item('unsigned', (t) => t.fgid >>> 0),
  ID_FGROUP: item('string', (t) => t.fgroup),
  ID_FUID: item('unsigned', (t) => t.fuid >>> 0),
  ID_FUSER: item('string', (t) => t.fuser),
  ID_LOGIN: item('number', (t) => t.luid | 0),
  ID_PGRP: item('number', (t) => t.pgrp),
  ID_PID: item('number', (t) => t.tid),
  ID_PPID: item('number', (t) => t.ppid),
  ID_RGID: item('unsigned', (t) => t.rgid >>> 0),
  ID_RGROUP: item('string', (t) => t.rgroup),
  ID_RUID: item('unsigned', (t) => t.ruid >>> 0),
  ID_RUSER: item('string', (t) => t.ruser),
  ID_SESSION: item('number', (t) => t.session),
  ID_SGID: item('unsigned', (t) => t.sgid >>> 0),
  ID_SGROUP: item('string', (t) => t.sgroup),
  ID_SUID: item('unsigned', (t) => t.suid >>> 0),
  ID_SUSER: item('string', (t) => t.suser),
  ID_TGID: item('number', (t) => t.tgid),
  ID_TPGID: item('number', (t) => t.tpgid),
  IO_READ_BYTES: item('unsigned', (t) => t.ioReadBytes),
  IO_READ_CHARS: item('unsigned', (t) => t.ioReadChars),
  IO_READ_OPS: item('unsigned', (t) => t.ioReadOps),
  IO_WRITE_BYTES: item('unsigned', (t) => t.ioWriteBytes),
  IO_WRITE_CBYTES: item('unsigned', (t) => t.ioWriteCBytes),
  IO_WRITE_CHARS: item('unsigned', (t) => t.ioWriteChars),
  IO_WRITE_OPS: item('unsigned', (t) => t.ioWriteOps),
  LXCNAME: item('string', (t) => t.lxcname),
  MEM_RES_PGS: item('unsigned', (t) => t.rssPages),
  MEM_SHR_PGS: item('unsigned', () => 0),
  NICE: item('number', (t) => t.nice),
  NLWP: item('number', (t) => t.nlwp),
  NS_CGROUP: item('unsigned', (t) => t.nsCgroup),
  NS_IPC: item('unsigned', (t) => t.nsIpc),
  NS_MNT: item('unsigned', (t) => t.nsMnt),
  NS_NET: item('unsigned', (t) => t.nsNet),
  NS_PID: item('unsigned', (t) => t.nsPid),
  NS_TIME: item('unsigned', (t) => t.nsTime),
  NS_USER: item('unsigned', (t) => t.nsUser),
  NS_UTS: item('unsigned', (t) => t.nsUts),
  OOM_ADJ: item('number', (t) => t.oomAdj),
  OOM_SCORE: item('number', (t) => t.oomScore),
  PRIORITY: item('number', (t) => t.priority),
  PRIORITY_RT: item('number', (t) => t.priorityRt),
  PROCESSOR: item('number', (t) => t.processor),
  PROCESSOR_NODE: item('number', (t) => t.processorNode),
  RSS_RLIM: item('unsigned', (t) => t.rssRlim),
  SCHED_CLASS: item('number', (t) => t.schedClass),
  SD_MACH: item('string', (t) => t.sdMach),
  SD_OUID: item('string', (t) => t.sdOuid),
  SD_SEAT: item('string', (t) => t.sdSeat),
  SD_SESS: item('string', (t) => t.sdSess),
  SD_SLICE: item('string', (t) => t.sdSlice),
  SD_UNIT: item('string', (t) => t.sdUnit),
  SD_UUNIT: item('string', (t) => t.sdUunit),
  SIGBLOCKED: item('string', (t) => t.sigBlocked),
  SIGCATCH: item('string', (t) => t.sigCatch),
  SIGIGNORE: item('string', (t) => t.sigIgnore),
  SIGNALS: item('string', (t) => t.signals),
  SIGPENDING: item('string', (t) => t.sigPending),
  SMAP_PRV_TOTAL: item('unsigned', (t) => t.smapPrivateTotal),
  SMAP_PSS: item('unsigned', (t) => t.smapPss),
  STATE: item('number', (t) => t.state.charCodeAt(0)),
  SUPGIDS: item('string', (t) => t.supgids),
  SUPGROUPS: item('string', (t) => t.supgrps),
  TICS_ALL: item('unsigned', (t) => t.ticsUser + t.ticsSystem),
  TICS_BEGAN: item('unsigned', (t) => t.ticsBegan),
  TICS_USER: item('unsigned', (t) => t.ticsUser),
  TICS_USER_C: item('unsigned', (t) => t.ticsUser + t.ticsUserC),
  TIME_ALL: item('unsigned', (t, c) => (t.ticsUser + t.ticsSystem) / c.hertz),
  TIME_ELAPSED: item('unsigned', (t, c) => (c.bootTics - t.ticsBegan > 0 ? (c.bootTics - t.ticsBegan) / c.hertz : 0)),
  TTY_NAME: item('string', (t) => t.ttyName),
  UTILIZATION: item('unsigned', utilization),
  UTILIZATION_C: item('unsigned', (t, c) => {
    const delta = c.bootTics - t.ticsBegan;
    return delta > 0 ? ((t.ticsUser + t.ticsSystem + t.ticsUserC + t.ticsSystemC) * 100) / delta : 0;
  }),
  VM_DATA: item('unsigned', (t) => t.vmData),
  VM_EXE: item('unsigned', (t) => t.vmExe),
  VM_LIB: item('unsigned', (t) => t.vmLib),
  VM_RSS: item('unsigned', (t) => t.vmRss),
  VM_RSS_LOCKED: item('unsigned', (t) => t.vmRssLocked),
  VM_SIZE: item('unsigned', (t) => t.vmSize),
  VM_STACK: item('unsigned', (t) => t.vmStack),
  VSIZE_BYTES: item('unsigned', (t) => t.vsizeBytes),
  WCHAN_NAME: item('string', (t) => t.wchanName),
};

export function compareForSort(kind: SortKind, left: SortValue, right: SortValue, order: number, collate: (a: string, b: string) => number): number {
  switch (kind) {
    case 'noop':
      return 0;
    case 'number':
      return order * ((left as number) - (right as number));
    case 'unsigned':
      if ((left as number) > (right as number)) return order > 0 ? 1 : -1;
      if ((left as number) < (right as number)) return order > 0 ? -1 : 1;
      return 0;
    case 'string':
      return order * collate(left as string, right as string);
  }
}
