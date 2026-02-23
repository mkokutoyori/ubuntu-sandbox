/**
 * LinuxLogManager — manages the systemd journal, dmesg ring buffer,
 * and /var/log/ files for the Linux simulator.
 */

import { VirtualFileSystem } from './VirtualFileSystem';

// ── Priority levels (syslog) ─────────────────────────────────────
const PRIORITY_NAMES: Record<string, number> = {
  emerg: 0, alert: 1, crit: 2, err: 3,
  warning: 4, notice: 5, info: 6, debug: 7,
};
const PRIORITY_LABELS: Record<number, string> = {
  0: 'emerg', 1: 'alert', 2: 'crit', 3: 'err',
  4: 'warning', 5: 'notice', 6: 'info', 7: 'debug',
};

// ── Facility names ───────────────────────────────────────────────
const FACILITY_NAMES: Record<string, number> = {
  kern: 0, user: 1, mail: 2, daemon: 3,
  auth: 4, syslog: 5, lpr: 6, news: 7,
  cron: 8, local0: 16, local1: 17, local2: 18,
  local3: 19, local4: 20, local5: 21, local6: 22, local7: 23,
};

// ── Log file routing ─────────────────────────────────────────────
const FACILITY_LOG_FILES: Record<string, string> = {
  auth: '/var/log/auth.log',
  kern: '/var/log/kern.log',
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

  constructor(private vfs: VirtualFileSystem) {
    this.bootTime = new Date();
    this.bootId = this.generateBootId();
    this.populateBootMessages();
  }

  // ── logger command ─────────────────────────────────────────────
  executeLogger(args: string[], currentUser: string): string {
    let tag = currentUser;
    let priority = 'user.notice';
    let includePid = false;
    const msgParts: string[] = [];

    let i = 0;
    while (i < args.length) {
      switch (args[i]) {
        case '-t': tag = args[++i] || tag; i++; break;
        case '-p': priority = args[++i] || priority; i++; break;
        case '-i': includePid = true; i++; break;
        case '-s': i++; break; // stderr flag, no-op in simulator
        default: msgParts.push(args[i]); i++; break;
      }
    }

    // Parse facility.priority
    const parsed = this.parsePriority(priority);
    if (!parsed) return `logger: unknown priority name: ${priority}`;

    const message = msgParts.join(' ');
    const pid = includePid ? this.nextPid++ : 0;

    this.addEntry({
      priority: parsed.priority,
      facility: parsed.facility,
      unit: '',
      tag,
      message,
      pid,
      hostname: this.hostname,
    });

    return '';
  }

  // ── journalctl command ─────────────────────────────────────────
  executeJournalctl(args: string[]): string {
    // Handle management commands first
    for (const arg of args) {
      if (arg === '--version') return 'systemd 249 (249.11-0ubuntu3)';
      if (arg === '--disk-usage') return this.cmdDiskUsage();
      if (arg === '--list-boots') return this.cmdListBoots();
      if (arg === '--rotate') return 'Rotating journal files...';
      if (arg === '--flush') return 'Flushing journal to persistent storage...';
      if (arg.startsWith('--vacuum-time')) return 'Vacuuming done, freed 0B of archived journals.';
      if (arg.startsWith('--vacuum-size')) return 'Vacuuming done, freed 0B of archived journals.';
    }

    // Parse query options
    let n = -1;  // -1 = show all
    let reverse = false;
    let quiet = false;
    let outputFormat = 'short';
    let unitFilter = '';
    let priorityFilter = -1;
    let pidFilter = -1;
    let outputFields: string[] = [];

    let i = 0;
    while (i < args.length) {
      switch (args[i]) {
        case '-n':
        case '--lines':
          n = parseInt(args[++i]) || 0;
          i++; break;
        case '-r':
        case '--reverse':
          reverse = true; i++; break;
        case '-q':
        case '--quiet':
          quiet = true; i++; break;
        case '-b':
        case '--boot':
          i++; break;  // always current boot in simulator
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
          // Check for _PID=N
          if (args[i].startsWith('_PID=')) {
            pidFilter = parseInt(args[i].slice(5));
          }
          // Check for --output-fields=
          if (args[i].startsWith('--output-fields=')) {
            outputFields = args[i].slice(16).split(',');
          }
          i++; break;
        }
      }
    }

    // Validate output format
    const validFormats = ['short', 'short-iso', 'json', 'json-pretty', 'cat', 'verbose'];
    if (!validFormats.includes(outputFormat)) {
      return `Invalid output format: ${outputFormat}`;
    }

    // Filter entries
    let entries = this.filterEntries(unitFilter, priorityFilter, pidFilter);

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

    // Add header unless quiet or non-short format
    if (!quiet && (outputFormat === 'short' || outputFormat === 'short-iso')) {
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
    let clearBuf = false;
    let levelFilter: string[] = [];

    let i = 0;
    while (i < args.length) {
      switch (args[i]) {
        case '-T':
        case '--ctime':
          humanTime = true; i++; break;
        case '-c':
        case '--read-clear':
          clearBuf = true; i++; break;
        case '-H':
        case '--human':
          humanTime = true; i++; break;
        case '-l':
        case '--level': {
          const levels = args[++i] || '';
          levelFilter = levels.split(',').map(l => l.trim());
          i++; break;
        }
        default: {
          if (args[i].startsWith('--level=')) {
            levelFilter = args[i].slice(8).split(',').map(l => l.trim());
          }
          i++; break;
        }
      }
    }

    // Permission check for -c
    if (clearBuf && uid !== 0) {
      return 'dmesg: read kernel buffer failed: Permission denied';
    }

    // Filter by level
    let entries = [...this.dmesgBuffer];
    if (levelFilter.length > 0) {
      const levelNums = levelFilter.map(l => PRIORITY_NAMES[l] ?? -1).filter(n => n >= 0);
      entries = entries.filter(e => levelNums.includes(e.level));
    }

    // Format output
    const lines = entries.map(e => {
      if (humanTime) {
        const ts = new Date(this.bootTime.getTime() + e.offsetSec * 1000);
        return `[${fmtHumanDate(ts)}] ${e.message}`;
      }
      const secs = e.offsetSec.toFixed(6);
      const padded = secs.padStart(12, ' ');
      return `[${padded}] ${e.message}`;
    });

    // Clear buffer after display
    if (clearBuf) {
      this.dmesgBuffer = [];
    }

    return lines.join('\n');
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
      hostname: opts.hostname,
    };
    this.journal.push(entry);

    // Write to log files
    const facilityName = this.facilityName(opts.facility);
    const logLine = this.formatSyslogLine(entry);

    // Always write to syslog (except for auth-only)
    this.appendToLogFile('/var/log/syslog', logLine);

    // Route to facility-specific log
    const specificFile = FACILITY_LOG_FILES[facilityName];
    if (specificFile) {
      this.appendToLogFile(specificFile, logLine);
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
    let entries = [...this.journal];

    if (unit) {
      entries = entries.filter(e => {
        // Match unit name against tag or unit field
        if (e.unit && e.unit.includes(unit)) return true;
        if (e.tag && e.tag.includes(unit)) return true;
        // Match "systemd" unit to entries with tag "systemd" or unit containing "systemd"
        return false;
      });
    }

    if (priority >= 0) {
      // Show entries at this priority or more severe (lower number)
      entries = entries.filter(e => e.priority <= priority);
    }

    if (pid >= 0) {
      entries = entries.filter(e => e.pid === pid);
    }

    return entries;
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
    const dot = spec.indexOf('.');
    if (dot >= 0) {
      const facName = spec.slice(0, dot);
      const priName = spec.slice(dot + 1);
      const fac = FACILITY_NAMES[facName];
      const pri = PRIORITY_NAMES[priName];
      if (fac === undefined || pri === undefined) return null;
      return { facility: fac, priority: pri };
    }
    // Priority only, default facility = user
    const pri = PRIORITY_NAMES[spec];
    if (pri === undefined) return null;
    return { facility: 1, priority: pri };
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
