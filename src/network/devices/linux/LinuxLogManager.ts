/**
 * LinuxLogManager — manages the systemd journal, dmesg ring buffer,
 * and /var/log/ files for the Linux simulator.
 */

import { VirtualFileSystem } from './VirtualFileSystem';
import type { IEventBus, Unsubscribe } from '@/events/EventBus';

// ── Priority levels (syslog) ─────────────────────────────────────
const PRIORITY_NAMES: Record<string, number> = {
  emerg: 0, emergency: 0, panic: 0, alert: 1, crit: 2, err: 3, error: 3,
  warning: 4, warn: 4, notice: 5, info: 6, debug: 7,
};
const PRIORITY_LABELS: Record<number, string> = {
  0: 'emerg', 1: 'alert', 2: 'crit', 3: 'err',
  4: 'warning', 5: 'notice', 6: 'info', 7: 'debug',
};

// ── Facility names ───────────────────────────────────────────────
const FACILITY_NAMES: Record<string, number> = {
  kern: 0, user: 1, mail: 2, daemon: 3,
  auth: 4, syslog: 5, lpr: 6, news: 7,
  cron: 8, authpriv: 10, ftp: 11,
  local0: 16, local1: 17, local2: 18,
  local3: 19, local4: 20, local5: 21, local6: 22, local7: 23,
};

// ── Journal entry ────────────────────────────────────────────────
interface JournalEntry {
  timestamp: Date;
  monotonicUsec: number;  // microseconds since boot
  priority: number;
  facility: number;
  unit: string;
  tag: string;
  message: string;
  pid: number;
  hostname: string;
}

// ── Dmesg entry ──────────────────────────────────────────────────
interface DmesgEntry {
  offsetSec: number;  // seconds since boot (float)
  level: number;
  message: string;
}

const JOURNALCTL_HELP = `journalctl [OPTIONS...] [MATCHES...]

Query the journal.

Options:
  -n --lines=INTEGER   Number of journal entries to show
  -r --reverse         Show the newest entries first
  -u --unit=UNIT       Show logs from the specified unit
  -p --priority=RANGE  Show entries with the specified priority
  -k --dmesg           Show kernel message log from the current boot
  -o --output=STRING   Change journal output mode
  -b --boot[=ID]       Show data only from the specified boot
  -N --fields          List all field names currently used
  --since=DATE         Show entries not older than the specified date
  --until=DATE         Show entries not newer than the specified date
     --no-pager        Do not pipe output into a pager
  -h --help            Show this help text`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtSyslogTimestamp(d: Date): string {
  const mon = MONTHS[d.getMonth()];
  const day = String(d.getDate()).padStart(2, ' ');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mon} ${day} ${hh}:${mm}:${ss}`;
}

function fmtIsoTimestamp(d: Date): string {
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mo}-${dd}T${hh}:${mm}:${ss}+0000`;
}

function fmtHumanDate(d: Date): string {
  const day = DAYS[d.getDay()];
  const mon = MONTHS[d.getMonth()];
  const dd = String(d.getDate()).padStart(2, ' ');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${day} ${mon} ${dd} ${hh}:${mm}:${ss} ${d.getFullYear()}`;
}

export class LinuxLogManager {
  private journal: JournalEntry[] = [];
  private dmesgBuffer: DmesgEntry[] = [];
  private bootTime: Date;
  private bootId: string;
  private hostname = 'localhost';
  private nextPid = 100;
  private monotonicCounter = 0;
  /**
   * Whether the syslog daemon (`rsyslog`) is running. When it is stopped
   * the on-disk `/var/log/*` files stop receiving new lines — exactly as on
   * a real host — while the systemd journal (kept in memory by journald)
   * keeps recording, so `journalctl` still works.
   */
  private syslogDaemonActive = true;
  private journaldActive = true;
  private busUnsub: Unsubscribe[] = [];
  private attachedBus: IEventBus | null = null;
  private attachedDeviceId: string | null = null;
  private readonly SEVERITY_NAME = [
    'emergencies', 'alerts', 'critical', 'errors',
    'warnings', 'notifications', 'informational', 'debugging',
  ] as const;

  constructor(private vfs: VirtualFileSystem) {
    this.bootTime = new Date(Date.now() - 30_000);
    this.bootId = this.generateBootId();
    this.populateBootMessages();
  }

  /**
   * Attach the device event bus so the syslog daemon's lifecycle drives
   * file-logging coherence: stopping `rsyslog` freezes `/var/log/*`,
   * starting it resumes them.
   */
  attachBus(bus: IEventBus, deviceId?: string): void {
    for (const off of this.busUnsub) off();
    this.attachedBus = bus;
    if (deviceId) this.attachedDeviceId = deviceId;
    const isSyslog = (p: { name: string }): boolean =>
      p.name === 'rsyslog' || p.name === 'syslog' || p.name === 'systemd-journald';
    this.busUnsub = [
      bus.subscribeWhere('linux.service.stopped', isSyslog, (e) => {
        if (e.payload.name !== 'systemd-journald') this.syslogDaemonActive = false;
        if (e.payload.name === 'systemd-journald') this.journaldActive = false;
      }),
      bus.subscribeWhere('linux.service.started', isSyslog, (e) => {
        if (e.payload.name !== 'systemd-journald') this.syslogDaemonActive = true;
        if (e.payload.name === 'systemd-journald') this.journaldActive = true;
      }),
      bus.subscribeWhere('linux.service.restarted', isSyslog, () => {
        this.syslogDaemonActive = true;
        this.journaldActive = true;
      }),
    ];
  }

  // ── logger command ─────────────────────────────────────────────
  executeLogger(args: string[], currentUser: string): string {
    let tag = currentUser;
    let priority = 'user.notice';
    let includePid = false;
    let toStderr = false;
    let expandNewlines = false;
    let fromFile: string | null = null;
    const msgParts: string[] = [];

    let i = 0;
    while (i < args.length) {
      const a = args[i];
      if (a === '-t' || a === '--tag') { tag = args[++i] ?? tag; i++; }
      else if (a === '-p' || a === '--priority') { priority = args[++i] ?? priority; i++; }
      else if (a === '-i' || a === '--id') { includePid = true; i++; }
      else if (a === '-s' || a === '--stderr') { toStderr = true; i++; }
      else if (a === '-e') { expandNewlines = true; i++; }
      else if (a === '-f' || a === '--file') { fromFile = args[++i] ?? null; i++; }
      else { msgParts.push(a); i++; }
    }

    const parsed = this.parsePriority(priority);
    if (!parsed) return `logger: unknown priority name: ${priority}`;

    let messages: string[];
    if (fromFile !== null) {
      const content = this.vfs.readFile(fromFile);
      if (content === null) return `logger: ${fromFile}: No such file or directory`;
      messages = content.split('\n').filter((l) => l.length > 0);
    } else {
      if (args.length === 0) return 'Usage: logger [options] [<message>]';
      let msg = msgParts.join(' ');
      if (expandNewlines) msg = msg.replace(/\\n/g, '\n');
      if (msg.length > 2048) msg = msg.slice(0, 2048);
      messages = [msg];
    }

    const safeTag = tag.length > 255 ? tag.slice(0, 255) : tag;
    const pid = includePid ? this.nextPid++ : 0;
    const echoed: string[] = [];
    for (const message of messages) {
      this.addEntry({
        priority: parsed.priority,
        facility: parsed.facility,
        unit: '',
        tag: safeTag,
        message,
        pid,
        hostname: this.hostname,
      });
      if (toStderr) {
        const last = this.journal[this.journal.length - 1];
        echoed.push(this.formatSyslogLine(last));
      }
    }

    return echoed.join('\n');
  }

  /**
   * Append a record at an explicit `facility.priority` spec (e.g.
   * `local0.info`) — the bridge a service uses when its syslog routing is
   * configurable. Oracle's AUDIT_SYSLOG_LEVEL is the first consumer.
   * Returns false when the spec is malformed (unknown facility/priority).
   */
  logAt(facilityPrioritySpec: string, tag: string, message: string, pid = 0): boolean {
    const parsed = this.parsePriority(facilityPrioritySpec);
    if (!parsed) return false;
    this.addEntry({
      priority: parsed.priority,
      facility: parsed.facility,
      unit: '',
      tag,
      message,
      pid,
      hostname: this.hostname,
    });
    return true;
  }

  /**
   * Append an authentication-facility record — the bridge the IAM layer uses
   * to keep `/var/log/auth.log` (and the journal) coherent with account
   * changes. `tag` is the responsible program (`useradd`, `passwd`, …).
   */
  logAuth(tag: string, message: string, pid?: number, unit?: string): void {
    this.addEntry({
      priority: PRIORITY_NAMES.info,
      facility: FACILITY_NAMES.auth,
      // Ubuntu's systemd unit for sshd is `ssh.service`, even though
      // the binary identifies itself as `sshd` in syslog lines. Let
      // callers split the two so `journalctl -u ssh` works and the
      // file line still reads `sshd[<pid>]:`.
      unit: unit ?? tag,
      tag,
      message,
      // Daemons like sshd keep a stable PID across forked sessions; the
      // caller passes its own so `journalctl -u ssh` shows that single
      // pid instead of one per emitted line.
      pid: pid ?? this.nextPid++,
      hostname: this.hostname,
    });
  }

  /**
   * Append a daemon-facility record — used by the port subsystem to log a
   * socket bind / release the way systemd-journald notes a daemon opening
   * or closing its listening port.
   */
  logDaemon(tag: string, message: string): void {
    this.addEntry({
      priority: PRIORITY_NAMES.info,
      facility: FACILITY_NAMES.daemon,
      unit: tag,
      tag,
      message,
      pid: this.nextPid++,
      hostname: this.hostname,
    });
  }

  /**
   * Append a systemd-facility record attributed to a specific unit — used by
   * the service-journal projection so `journalctl -u <unit>` shows the
   * "Started / Stopped …" lines systemd writes on every state change.
   */
  logKernel(tag: string, message: string): void {
    this.addEntry({
      priority: PRIORITY_NAMES.warning,
      facility: FACILITY_NAMES.kern,
      unit: tag,
      tag,
      message,
      pid: 0,
      hostname: this.hostname,
    });
  }

  logSystemd(unit: string, message: string): void {
    this.addEntry({
      priority: PRIORITY_NAMES.info,
      facility: FACILITY_NAMES.daemon,
      unit,
      tag: 'systemd',
      message,
      pid: 1,
      hostname: this.hostname,
    });
  }

  // ── journalctl command ─────────────────────────────────────────
  executeJournalctl(args: string[]): string {
    for (const arg of args) {
      if (arg === '--version') return 'systemd 249 (249.11-0ubuntu3)';
      if (arg === '-h' || arg === '--help') return JOURNALCTL_HELP;
      if (arg === '-N' || arg === '--fields') {
        return ['MESSAGE', 'PRIORITY', 'SYSLOG_FACILITY', 'SYSLOG_IDENTIFIER',
          '_PID', '_UID', '_GID', '_HOSTNAME', '_TRANSPORT', '_SYSTEMD_UNIT',
          '__REALTIME_TIMESTAMP', '__MONOTONIC_TIMESTAMP'].join('\n');
      }
      if (arg === '--disk-usage') return this.cmdDiskUsage();
      if (arg === '--list-boots') return this.cmdListBoots();
      if (arg === '--rotate') return 'Rotating journal files...';
      if (arg === '--flush') return 'Flushing journal to persistent storage...';
      if (arg.startsWith('--vacuum-time')) return 'Vacuuming done, freed 0B of archived journals.';
      if (arg.startsWith('--vacuum-size')) return 'Vacuuming done, freed 0B of archived journals.';
    }

    if (!this.journaldActive) return 'No journal files were found.';

    let n = -1;
    let reverse = false;
    let quiet = false;
    let outputFormat = 'short';
    let unitFilter = '';
    let priorityFilter = -1;
    let pidFilter = -1;
    let outputFields: string[] = [];
    let kernelOnly = false;
    let sinceMs = -1;
    let untilMs = -1;

    let i = 0;
    while (i < args.length) {
      switch (args[i]) {
        case '-n':
        case '--lines': {
          const v = args[++i] ?? '';
          if (!/^\d+$/.test(v)) return `journalctl: invalid number of lines: "${v}".`;
          n = parseInt(v, 10);
          i++; break;
        }
        case '-r':
        case '--reverse':
          reverse = true; i++; break;
        case '-q':
        case '--quiet':
          quiet = true; i++; break;
        case '-k':
        case '--dmesg':
          kernelOnly = true; i++; break;
        case '-x': case '--catalog':
        case '-f': case '--follow':
          i++; break;
        case '-b':
        case '--boot': {
          const nxt = args[i + 1];
          if (nxt && /^-?\d+$/.test(nxt)) {
            if (parseInt(nxt, 10) < 0) return `Failed to look up boot ${nxt}: no such boot ID`;
            i++;
          }
          i++; break;
        }
        case '-D': case '--directory': {
          const dir = args[++i] ?? '';
          if (dir.startsWith('/sys') || dir.startsWith('/proc')) return `Failed to open directory ${dir}: error`;
          i++; break;
        }
        case '--since': case '-S':
          sinceMs = this.parseJournalTime(args[++i] ?? ''); i++; break;
        case '--until': case '-U':
          untilMs = this.parseJournalTime(args[++i] ?? ''); i++; break;
        case '--no-pager':
          i++; break;  // no-op
        case '-o':
        case '--output':
          outputFormat = args[++i] || 'short';
          i++; break;
        case '-u':
        case '--unit': {
          unitFilter = args[++i] || '';
          i++; break;
        }
        case '-p':
        case '--priority': {
          const pval = args[++i] || '';
          const pnum = this.resolvePriority(pval);
          if (pnum === -1) return `Invalid priority: ${pval}`;
          priorityFilter = pnum;
          i++; break;
        }
        default: {
          if (args[i].startsWith('--facility')) { i++; break; }
          if (args[i].startsWith('_PID=')) pidFilter = parseInt(args[i].slice(5));
          if (args[i].startsWith('--output-fields=')) outputFields = args[i].slice(16).split(',');
          i++; break;
        }
      }
    }

    // Validate output format
    const validFormats = ['short', 'short-iso', 'json', 'json-pretty', 'cat', 'verbose'];
    if (!validFormats.includes(outputFormat)) {
      return `Invalid argument: unknown output format "${outputFormat}".`;
    }

    // Filter entries
    let entries = this.filterEntries(unitFilter, priorityFilter, pidFilter);
    if (kernelOnly) entries = entries.filter((e) => e.facility === FACILITY_NAMES.kern);
    if (sinceMs >= 0) entries = entries.filter((e) => e.timestamp.getTime() >= sinceMs);
    if (untilMs >= 0) entries = entries.filter((e) => e.timestamp.getTime() <= untilMs);

    // Hide entries with timestamps in the future. The boot-time canned
    // messages (kernel + systemd + sshd "Server listening on …") are
    // staggered along synthetic offsets from bootTime — when the host
    // is queried within the first few seconds, some offsets exceed real
    // wall-clock time and would surface as "events that haven't
    // happened yet" relative to `date(1)`. Real journalctl only ever
    // returns entries it has already received.
    const nowMs = Date.now();
    entries = entries.filter((e) => e.timestamp.getTime() <= nowMs);

    if (entries.length === 0) return '-- No entries --';

    // Apply -n
    if (n >= 0) {
      entries = entries.slice(-n);
    }

    // Apply -r
    if (reverse) {
      entries = [...entries].reverse();
    }

    // Format output
    const lines = entries.map(e => this.formatEntry(e, outputFormat, outputFields));

    // Add header unless quiet, reversed, or non-short format
    if (!quiet && !reverse && (outputFormat === 'short' || outputFormat === 'short-iso')) {
      const first = this.journal[0];
      const last = this.journal[this.journal.length - 1];
      if (first && last) {
        const header = `-- Logs begin at ${fmtHumanDate(first.timestamp)}, end at ${fmtHumanDate(last.timestamp)}. --`;
        return header + '\n' + lines.join('\n');
      }
    }

    return lines.join('\n');
  }

  // ── dmesg command ──────────────────────────────────────────────
  executeDmesg(args: string[], uid: number): string {
    let humanTime = false;
    let clearBuf = false;      // -c: print then clear
    let clearOnly = false;     // -C: clear, no print
    let raw = false;
    let levelFilter: string[] = [];
    let setConsoleLevel: number | null = null;

    let i = 0;
    while (i < args.length) {
      const a = args[i];
      switch (a) {
        case '-T': case '--ctime': case '-H': case '--human': humanTime = true; i++; break;
        case '-c': case '--read-clear': clearBuf = true; i++; break;
        case '-C': case '--clear': clearOnly = true; i++; break;
        case '-r': case '--raw': raw = true; i++; break;
        case '-x': case '--decode': i++; break;
        case '-w': case '--follow': case '-d': case '--show-delta': i++; break;
        case '-h': case '--help':
          return 'Usage:\n dmesg [options]\n\nDisplay or control the kernel ring buffer.\n\nOptions:\n -C, --clear        clear the kernel ring buffer\n -c, --read-clear   read and clear all messages\n -T, --ctime        show human-readable timestamp\n -l, --level <list> restrict output to defined levels\n -n, --console-level <level> set level of messages printed to console\n -r, --raw          print the raw message buffer\n -x, --decode       decode facility and level\n -h, --help         display this help\n -V, --version      display version';
        case '-V': case '--version':
          return 'dmesg from util-linux 2.37.2';
        case '-n': case '--console-level': {
          const lvl = args[++i] ?? '';
          const n = /^\d+$/.test(lvl) ? parseInt(lvl, 10) : (PRIORITY_NAMES[lvl] ?? -1);
          if (n < 1 || n > 8) return `dmesg: invalid console level: ${lvl}`;
          setConsoleLevel = n; i++; break;
        }
        case '-l': case '--level': {
          levelFilter = (args[++i] || '').split(',').map(l => l.trim()).filter(Boolean);
          i++; break;
        }
        case '-f': case '--facility': i += 2; break;
        default:
          if (a.startsWith('--level=')) levelFilter = a.slice(8).split(',').map(l => l.trim()).filter(Boolean);
          i++; break;
      }
    }

    // Privileged operations: clearing the buffer and setting console level.
    if ((clearBuf || clearOnly || setConsoleLevel !== null) && uid !== 0) {
      return 'dmesg: read kernel buffer failed: Permission denied';
    }

    if (setConsoleLevel !== null) return '';

    if (clearOnly) { this.dmesgBuffer = []; return ''; }

    // Validate level filter names.
    for (const l of levelFilter) {
      if (PRIORITY_NAMES[l] === undefined) return `dmesg: unknown level '${l}'`;
    }

    let entries = [...this.dmesgBuffer];
    if (levelFilter.length > 0) {
      const levelNums = levelFilter.map(l => PRIORITY_NAMES[l]);
      entries = entries.filter(e => levelNums.includes(e.level));
    }

    const lines = entries.map(e => this.formatDmesgEntry(e, { raw, humanTime }));

    if (clearBuf) this.dmesgBuffer = [];

    return lines.join('\n');
  }

  private formatDmesgEntry(e: DmesgEntry, opts: { raw: boolean; humanTime: boolean }): string {
    if (opts.raw) return e.message;
    if (opts.humanTime) {
      const ts = new Date(this.bootTime.getTime() + e.offsetSec * 1000);
      return `[${fmtHumanDate(ts)}] ${e.message}`;
    }
    return `[${e.offsetSec.toFixed(6).padStart(12, ' ')}] ${e.message}`;
  }

  private readonly dmesgFollowSubs = new Set<{
    raw: boolean;
    humanTime: boolean;
    levels: number[] | null;
    listener: (line: string) => void;
  }>();

  followDmesg(
    opts: { raw?: boolean; humanTime?: boolean; levelFilter?: readonly string[] },
    listener: (line: string) => void,
  ): () => void {
    const filter = opts.levelFilter && opts.levelFilter.length > 0
      ? opts.levelFilter
          .map((l) => PRIORITY_NAMES[l])
          .filter((n): n is number => typeof n === 'number')
      : null;
    const sub = {
      raw: !!opts.raw,
      humanTime: !!opts.humanTime,
      levels: filter && filter.length > 0 ? filter : null,
      listener,
    };
    this.dmesgFollowSubs.add(sub);
    return () => { this.dmesgFollowSubs.delete(sub); };
  }

  private emitToDmesgFollowers(entry: DmesgEntry): void {
    if (this.dmesgFollowSubs.size === 0) return;
    for (const sub of this.dmesgFollowSubs) {
      if (sub.levels && !sub.levels.includes(entry.level)) continue;
      sub.listener(this.formatDmesgEntry(entry, { raw: sub.raw, humanTime: sub.humanTime }));
    }
  }

  // ── Internal methods ───────────────────────────────────────────

  private addEntry(opts: {
    priority: number; facility: number; unit: string;
    tag: string; message: string; pid: number; hostname: string;
  }): void {
    this.monotonicCounter += 1000;
    const entry: JournalEntry = {
      timestamp: new Date(),
      monotonicUsec: this.monotonicCounter,
      priority: opts.priority,
      facility: opts.facility,
      unit: opts.unit,
      tag: opts.tag,
      message: opts.message,
      pid: opts.pid,
      hostname: this.currentHostname(),
    };
    // journald keeps the in-memory journal regardless of rsyslog's state.
    this.journal.push(entry);
    // Kernel-facility messages also land in the kernel ring buffer (dmesg).
    if (opts.facility === FACILITY_NAMES.kern) {
      const dEntry: DmesgEntry = {
        offsetSec: (entry.timestamp.getTime() - this.bootTime.getTime()) / 1000,
        level: opts.priority,
        message: opts.message,
      };
      this.dmesgBuffer.push(dEntry);
      this.emitToDmesgFollowers(dEntry);
    }
    this.emitToFollowers(entry);

    // The on-disk /var/log/* files are written by rsyslog: when that daemon
    // is stopped they freeze, but `journalctl` keeps working.
    if (!this.syslogDaemonActive) return;

    const facilityName = this.facilityName(opts.facility);
    const logLine = this.formatSyslogLine(entry);

    for (const file of this.routeLogFiles(facilityName, opts.priority)) {
      this.appendToLogFile(file, logLine);
    }

    if (this.attachedBus && this.attachedDeviceId) {
      const sevName = this.SEVERITY_NAME[opts.priority] ?? 'informational';
      this.attachedBus.publish({
        topic: 'device.syslog.entry',
        payload: {
          deviceId: this.attachedDeviceId,
          severity: sevName, severityNum: opts.priority,
          tag: opts.tag, message: opts.message, ts: entry.timestamp.getTime(),
        },
      });
    }
  }

  private formatSyslogLine(entry: JournalEntry): string {
    const ts = fmtSyslogTimestamp(entry.timestamp);
    const pidPart = entry.pid > 0 ? `[${entry.pid}]` : '';
    return `${ts} ${entry.hostname} ${entry.tag}${pidPart}: ${entry.message}`;
  }

  private appendToLogFile(path: string, line: string): void {
    const existing = this.vfs.readFile(path);
    if (existing !== null) {
      this.vfs.writeFile(path, existing + line + '\n', 0, 0, 0o022);
    } else {
      // Create log file if missing
      this.vfs.createFileAt(path, line + '\n', 0o640, 0, 4); // syslog group = adm (4)
    }
  }

  private filterEntries(unit: string, priority: number, pid: number): JournalEntry[] {
    return this.journal.filter((e) => this.entryMatches(e, unit, priority, pid));
  }

  private entryMatches(e: JournalEntry, unit: string, priority: number, pid: number): boolean {
    if (unit) {
      const u = unit.replace(/\.service$/, '');
      const hit = (e.unit && e.unit.includes(u))
        || (e.tag && e.tag.includes(u))
        || e.message.startsWith(`${u}.service`)
        || e.message.includes(`${u}.service:`)
        || e.message.includes(`${u}[`);
      if (!hit) return false;
    }
    if (priority >= 0 && e.priority > priority) return false;
    if (pid >= 0 && e.pid !== pid) return false;
    return true;
  }

  private parseJournalTime(spec: string): number {
    const s = spec.trim().toLowerCase();
    if (s === '' || s === 'now') return Date.now();
    const ago = s.match(/^(\d+)\s*(second|minute|hour|day|week)s?\s*(ago)?$/);
    if (ago) {
      const mult: Record<string, number> = {
        second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000,
      };
      return Date.now() - parseInt(ago[1], 10) * mult[ago[2]];
    }
    const t = Date.parse(spec);
    return isNaN(t) ? Date.now() : t;
  }

  private readonly followSubs = new Set<{ unit: string; priority: number; pid: number; listener: (line: string) => void }>();

  /** Subscribe to live journal lines (journalctl -f). Returns an unsubscribe. */
  followJournal(opts: { unit?: string; priority?: number; pid?: number }, listener: (line: string) => void): () => void {
    const sub = { unit: opts.unit ?? '', priority: opts.priority ?? -1, pid: opts.pid ?? -1, listener };
    this.followSubs.add(sub);
    return () => { this.followSubs.delete(sub); };
  }

  private emitToFollowers(entry: JournalEntry): void {
    if (this.followSubs.size === 0) return;
    for (const sub of this.followSubs) {
      if (this.entryMatches(entry, sub.unit, sub.priority, sub.pid)) {
        sub.listener(this.formatEntry(entry, 'short', []));
      }
    }
  }

  private formatEntry(entry: JournalEntry, format: string, outputFields: string[]): string {
    switch (format) {
      case 'short': {
        const ts = fmtSyslogTimestamp(entry.timestamp);
        const pidPart = entry.pid > 0 ? `[${entry.pid}]` : '';
        return `${ts} ${entry.hostname} ${entry.tag}${pidPart}: ${entry.message}`;
      }
      case 'short-iso': {
        const ts = fmtIsoTimestamp(entry.timestamp);
        const pidPart = entry.pid > 0 ? `[${entry.pid}]` : '';
        return `${ts} ${entry.hostname} ${entry.tag}${pidPart}: ${entry.message}`;
      }
      case 'cat':
        return entry.message;
      case 'json':
      case 'json-pretty': {
        const obj: Record<string, string> = {
          '__REALTIME_TIMESTAMP': String(entry.timestamp.getTime() * 1000),
          '_HOSTNAME': entry.hostname,
          'PRIORITY': String(entry.priority),
          'SYSLOG_FACILITY': String(entry.facility),
          'SYSLOG_IDENTIFIER': entry.tag,
          '_PID': String(entry.pid),
          'MESSAGE': entry.message,
          '_SYSTEMD_UNIT': entry.unit || '',
        };
        // Apply output fields filter
        let filtered = obj;
        if (outputFields.length > 0) {
          filtered = {};
          for (const f of outputFields) {
            if (f in obj) filtered[f] = obj[f];
          }
        }
        return format === 'json-pretty'
          ? JSON.stringify(filtered, null, 4)
          : JSON.stringify(filtered);
      }
      case 'verbose': {
        const ts = fmtHumanDate(entry.timestamp);
        return [
          `${ts} [s=${this.bootId}]`,
          `    PRIORITY=${entry.priority}`,
          `    SYSLOG_FACILITY=${entry.facility}`,
          `    SYSLOG_IDENTIFIER=${entry.tag}`,
          `    MESSAGE=${entry.message}`,
          `    _PID=${entry.pid}`,
          `    _HOSTNAME=${entry.hostname}`,
          `    _SYSTEMD_UNIT=${entry.unit}`,
        ].join('\n');
      }
      default:
        return entry.message;
    }
  }

  private parsePriority(spec: string): { facility: number; priority: number } | null {
    // Whole numeric priority: PRI = facility*8 + severity.
    if (/^\d+$/.test(spec)) {
      const n = parseInt(spec, 10);
      if (n < 0 || n > 191) return null;
      return { facility: Math.floor(n / 8), priority: n % 8 };
    }
    const dot = spec.indexOf('.');
    if (dot >= 0) {
      const fac = FACILITY_NAMES[spec.slice(0, dot)];
      const pri = PRIORITY_NAMES[spec.slice(dot + 1)];
      if (fac === undefined || pri === undefined) return null;
      return { facility: fac, priority: pri };
    }
    // Priority only, default facility = user
    const pri = PRIORITY_NAMES[spec];
    if (pri === undefined) return null;
    return { facility: 1, priority: pri };
  }

  private currentHostname(): string {
    const h = this.vfs.readFile('/etc/hostname');
    return h ? h.trim() : this.hostname;
  }

  private routeLogFiles(facilityName: string, priority: number): string[] {
    const files = ['/var/log/syslog'];
    if (facilityName === 'auth' || facilityName === 'authpriv') files.push('/var/log/auth.log');
    else if (facilityName === 'kern') files.push('/var/log/kern.log');
    else if (facilityName === 'cron') files.push('/var/log/cron.log');
    else if (facilityName === 'mail') {
      files.push('/var/log/mail.log');
      if (priority <= PRIORITY_NAMES.err) files.push('/var/log/mail.err');
    }
    return files;
  }

  private resolvePriority(val: string): number {
    // Numeric
    const num = parseInt(val);
    if (!isNaN(num) && num >= 0 && num <= 7) return num;
    // Named
    const pri = PRIORITY_NAMES[val];
    return pri !== undefined ? pri : -1;
  }

  private facilityName(facility: number): string {
    for (const [name, num] of Object.entries(FACILITY_NAMES)) {
      if (num === facility) return name;
    }
    return 'user';
  }

  private cmdDiskUsage(): string {
    const bytes = this.journal.length * 128; // rough estimate
    let size: string;
    if (bytes < 1024) size = `${bytes}B`;
    else if (bytes < 1024 * 1024) size = `${(bytes / 1024).toFixed(1)}K`;
    else size = `${(bytes / (1024 * 1024)).toFixed(1)}M`;
    return `Archived and active journals take up ${size} in the file system.`;
  }

  private cmdListBoots(): string {
    const ts = fmtHumanDate(this.bootTime);
    const now = fmtHumanDate(new Date());
    return ` 0 ${this.bootId} ${ts}—${now}`;
  }

  private generateBootId(): string {
    const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}`;
  }

  // ── Boot message population ────────────────────────────────────
  private populateBootMessages(): void {
    const bt = this.bootTime;

    // Kernel dmesg messages
    const kernelMsgs: Array<{ offset: number; level: number; msg: string }> = [
      { offset: 0.000000, level: 6, msg: 'Linux version 5.15.0-generic (buildd@lcy02-amd64-032) (gcc-11 (Ubuntu 11.3.0-1ubuntu1~22.04) 11.3.0) #1 SMP x86_64' },
      { offset: 0.000001, level: 6, msg: 'Command line: BOOT_IMAGE=/vmlinuz-5.15.0-generic root=/dev/sda1 ro quiet splash' },
      { offset: 0.010000, level: 6, msg: 'DMI: QEMU Standard PC (i440FX + PIIX, 1996), BIOS 1.16.2-debian-1.16.2-1 04/01/2014' },
      { offset: 0.050000, level: 6, msg: 'Memory: 2048000K/2097152K available (14339K kernel code, 2560K rwdata)' },
      { offset: 0.100000, level: 6, msg: 'CPU: Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz' },
      { offset: 0.500000, level: 6, msg: 'NET: Registered PF_INET protocol family' },
      { offset: 0.600000, level: 6, msg: 'NET: Registered PF_INET6 protocol family' },
      { offset: 0.300000, level: 6, msg: 'PCI: Using configuration type 1 for base access' },
      { offset: 0.310000, level: 6, msg: 'pci 0000:00:01.0: PIIX/ICH IDE controller' },
      { offset: 0.320000, level: 6, msg: 'usbcore: registered new interface driver usbfs' },
      { offset: 0.330000, level: 6, msg: 'usbcore: registered new interface driver hub' },
      { offset: 0.340000, level: 6, msg: 'e1000: Intel(R) PRO/1000 Network Driver' },
      { offset: 0.350000, level: 6, msg: 'e1000 0000:00:03.0 eth0: (PCI:33MHz:32-bit) link up' },
      { offset: 1.000000, level: 6, msg: 'EXT4-fs (sda1): mounted filesystem with ordered data mode. Opts: (null)' },
      { offset: 1.200000, level: 6, msg: 'EXT4-fs (sda1): re-mounted. Opts: errors=remount-ro' },
    ];

    for (const km of kernelMsgs) {
      this.dmesgBuffer.push({ offsetSec: km.offset, level: km.level, message: km.msg });
      // Also add to journal
      this.journal.push({
        timestamp: new Date(bt.getTime() + km.offset * 1000),
        monotonicUsec: Math.floor(km.offset * 1000000),
        priority: km.level,
        facility: 0, // kern
        unit: '',
        tag: 'kernel',
        message: km.msg,
        pid: 0,
        hostname: this.hostname,
      });
    }

    // Systemd boot messages
    const systemdMsgs: Array<{ tag: string; unit: string; pid: number; msg: string; pri: number; fac: number }> = [
      { tag: 'systemd', unit: 'systemd', pid: 1, msg: 'systemd 249.11-0ubuntu3 running in system mode (+PAM +AUDIT +SELINUX +APPARMOR)', pri: 6, fac: 3 },
      { tag: 'systemd', unit: 'systemd', pid: 1, msg: 'Started systemd-journald.service - Journal Service.', pri: 6, fac: 3 },
      { tag: 'systemd', unit: 'systemd', pid: 1, msg: 'Started systemd-logind.service - User Login Management.', pri: 6, fac: 3 },
      { tag: 'systemd', unit: 'systemd', pid: 1, msg: 'Started cron.service - Regular background program processing daemon.', pri: 6, fac: 3 },
      { tag: 'systemd', unit: 'systemd', pid: 1, msg: 'Started ssh.service - OpenBSD Secure Shell server.', pri: 6, fac: 3 },
      { tag: 'systemd', unit: 'systemd', pid: 1, msg: 'Reached target multi-user.target - Multi-User System.', pri: 6, fac: 3 },
    ];

    let offset = 2.0;
    for (const sm of systemdMsgs) {
      offset += 0.1;
      this.journal.push({
        timestamp: new Date(bt.getTime() + offset * 1000),
        monotonicUsec: Math.floor(offset * 1000000),
        priority: sm.pri,
        facility: sm.fac,
        unit: sm.unit,
        tag: sm.tag,
        message: sm.msg,
        pid: sm.pid,
        hostname: this.hostname,
      });
    }

    // SSH daemon messages
    const sshPid = 1234;
    const sshMsgs = [
      'Server listening on 0.0.0.0 port 22.',
      'Server listening on :: port 22.',
    ];
    offset = 3.0;
    for (const msg of sshMsgs) {
      offset += 0.1;
      this.journal.push({
        timestamp: new Date(bt.getTime() + offset * 1000),
        monotonicUsec: Math.floor(offset * 1000000),
        priority: 6,
        facility: 3, // daemon
        unit: 'ssh',
        tag: 'sshd',
        message: msg,
        pid: sshPid,
        hostname: this.hostname,
      });
    }

    // Auth/logind messages
    const logindPid = 456;
    const authMsgs = [
      'New seat seat0.',
      'Watching system buttons on /dev/input/event0.',
    ];
    offset = 2.5;
    for (const msg of authMsgs) {
      offset += 0.1;
      this.journal.push({
        timestamp: new Date(bt.getTime() + offset * 1000),
        monotonicUsec: Math.floor(offset * 1000000),
        priority: 6,
        facility: 4, // auth
        unit: 'systemd-logind',
        tag: 'systemd-logind',
        message: msg,
        pid: logindPid,
        hostname: this.hostname,
      });
    }

    // Set monotonic counter past boot messages
    this.monotonicCounter = 5000000;

    // Write initial log files
    this.writeInitialLogFiles();
  }

  private writeInitialLogFiles(): void {
    // /var/log/syslog - all non-auth entries
    const syslogLines = this.journal
      .filter(e => this.facilityName(e.facility) !== 'auth')
      .map(e => this.formatSyslogLine(e));
    this.vfs.createFileAt('/var/log/syslog', syslogLines.join('\n') + '\n', 0o640, 0, 4);

    // /var/log/auth.log - auth facility
    const authLines = this.journal
      .filter(e => e.facility === FACILITY_NAMES['auth'])
      .map(e => this.formatSyslogLine(e));
    this.vfs.createFileAt('/var/log/auth.log', authLines.join('\n') + '\n', 0o640, 0, 4);

    // /var/log/kern.log - kernel facility
    const kernLines = this.journal
      .filter(e => e.facility === FACILITY_NAMES['kern'])
      .map(e => this.formatSyslogLine(e));
    this.vfs.createFileAt('/var/log/kern.log', kernLines.join('\n') + '\n', 0o640, 0, 4);

    // /var/log/boot.log - systemd + kernel boot messages
    const bootLines = this.journal
      .filter(e => e.tag === 'systemd' || e.tag === 'kernel')
      .map(e => this.formatSyslogLine(e));
    this.vfs.createFileAt('/var/log/boot.log', bootLines.join('\n') + '\n', 0o640, 0, 4);
  }
}
