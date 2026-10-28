import { LocalCalendar, type BrokenDownTime } from '../../../logrotate/CalendarTime';
import { PID_MAX } from '../../../LinuxProcessManager';
import { buildTask, ttyDeviceNumber } from '../../../process/ProcessTaskBuilder';
import type { ProcessTask } from '../../../process/ProcessTask';
import type { LinuxCommandContext } from '../../LinuxCommandContext';
import type { PsHost, PsTerminal, PsTtyLookup } from './PsHost';

const HERTZ = 100;
const PAGE_SIZE_BYTES = 4096;
const CONTROLLING_TERMINAL = 'pts/0';
const PSEUDO_TERMINAL = /^\/dev\/pts\/(\d+)$/;
const SERIAL_OR_VIRTUAL_TERMINAL = /^\/dev\/(tty\d+|ttyS\d+)$/;
const NULL_DEVICE = (1 << 8) | 3;

export type PsHostSource = Pick<LinuxCommandContext, 'executor' | 'outputPiped'>;

export class PsProcHost implements PsHost {
  readonly selfPid: number;
  private readonly executor: LinuxCommandContext['executor'];
  private readonly environ: Readonly<Record<string, string>>;
  private readonly calendar: LocalCalendar;
  private readonly bootEpochMs: number;
  private readonly nowMs: number;

  constructor(private readonly ctx: PsHostSource, args: readonly string[]) {
    this.executor = ctx.executor;
    this.environ = this.executor.environmentOfCommand();
    this.calendar = new LocalCalendar(this.executor.localZone());
    this.nowMs = this.executor.simulatedDate().getTime();
    this.bootEpochMs = (this.executor.lifecycle.bootedAt() ?? this.executor.simulatedDate()).getTime();
    const self = this.executor.processMgr.spawn({
      command: ['ps', ...args].join(' '),
      comm: 'ps',
      user: this.executor.userMgr.currentUser,
      uid: this.executor.userMgr.currentUid,
      gid: this.executor.userMgr.currentGid,
      ppid: this.executor.currentPid(),
      tty: CONTROLLING_TERMINAL,
      cwd: this.executor.getCwd(),
      vsize: 7908,
      rss: 4076,
      environ: this.environ,
    });
    this.executor.processMgr.setState(self.pid, 'R');
    this.selfPid = self.pid;
  }

  release(): void {
    this.executor.processMgr.exit(this.selfPid, 0);
    this.executor.processMgr.reap(this.selfPid);
  }

  get hertz(): number { return HERTZ; }
  get pageSizeBytes(): number { return PAGE_SIZE_BYTES; }
  get memoryTotalKb(): number { return this.executor.hardware.memory.totalKib; }
  get pidDigits(): number { return Math.max(5, String(PID_MAX).length); }
  get bootTimeSeconds(): number { return Math.floor(this.bootEpochMs / 1000); }
  get uptimeSeconds(): number { return (this.nowMs - this.bootEpochMs) / 1000; }
  get nowSeconds(): number { return Math.floor(this.nowMs / 1000); }
  get effectiveUid(): number { return this.executor.userMgr.currentUid; }
  get controllingTty(): number { return this.environ['SSH_NO_TTY'] === '1' ? 0 : ttyDeviceNumber(CONTROLLING_TERMINAL); }

  get terminal(): PsTerminal {
    return {
      isTerminal: this.ctx.outputPiped !== true,
      columns: this.executor.terminalColumns(),
      rows: this.executor.getWindowSize().rows,
    };
  }

  get utf8(): boolean {
    const locale = this.environ['LC_ALL'] || this.environ['LC_CTYPE'] || this.environ['LANG'] || '';
    return /utf-?8/i.test(locale);
  }

  environment(name: string): string | undefined {
    return this.environ[name];
  }

  collate(left: string, right: string): number {
    const locale = this.environ['LC_ALL'] || this.environ['LC_COLLATE'] || this.environ['LANG'] || '';
    if (locale === '' || locale === 'C' || locale === 'POSIX') return left < right ? -1 : left > right ? 1 : 0;
    return left.localeCompare(right, 'en');
  }

  private allTasks(): ProcessTask[] {
    const facts = this.executor.taskFacts();
    return this.executor.processMgr.list()
      .sort((a, b) => a.pid - b.pid)
      .map((info) => buildTask(info, facts));
  }

  private withThreads(tasks: readonly ProcessTask[], includeThreads: boolean): ProcessTask[] {
    if (!includeThreads) return [...tasks];
    return tasks.flatMap((task) => [task, ...Array.from({ length: Math.max(0, task.nlwp - 1) }, (_, index) => ({ ...task, tid: task.tid + index + 1 }))]);
  }

  tasks(includeThreads: boolean): readonly ProcessTask[] {
    return this.withThreads(this.allTasks(), includeThreads);
  }

  selected(pids: readonly number[], includeThreads: boolean): readonly ProcessTask[] {
    const byPid = new Map(this.allTasks().map((task) => [task.tid, task]));
    const found = pids.flatMap((pid) => {
      const task = byPid.get(pid);
      return task === undefined ? [] : [task];
    });
    return this.withThreads(found, includeThreads);
  }

  userId(name: string): number | null {
    return this.executor.userMgr.getUser(name)?.uid ?? null;
  }

  groupId(name: string): number | null {
    return this.executor.userMgr.getGroup(name)?.gid ?? null;
  }

  statTty(path: string): PsTtyLookup | null {
    const absolute = this.executor.vfs.normalizePath(path, this.executor.getCwd());
    const pty = PSEUDO_TERMINAL.exec(absolute);
    if (pty !== null) {
      return this.executor.ptyExists(`pts/${pty[1]}`) ? { isCharacterDevice: true, device: ttyDeviceNumber(`pts/${pty[1]}`) } : null;
    }
    const inode = this.executor.vfs.resolveInode(absolute);
    if (inode === null) return null;
    if (inode.type !== 'chardev') return { isCharacterDevice: false, device: 0 };
    const terminal = SERIAL_OR_VIRTUAL_TERMINAL.exec(absolute);
    return { isCharacterDevice: true, device: terminal === null ? NULL_DEVICE : ttyDeviceNumber(terminal[1]) };
  }

  localTime(epochSeconds: number): BrokenDownTime {
    return this.calendar.localtime(epochSeconds);
  }

  formatTime(format: string, epochSeconds: number): string {
    return this.calendar.strftime(format, this.calendar.localtime(epochSeconds));
  }
}
