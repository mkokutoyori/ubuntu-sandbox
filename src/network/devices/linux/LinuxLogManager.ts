/**
 * LinuxLogManager — manages the systemd journal, dmesg ring buffer,
 * and /var/log/ files for the Linux simulator.
 */

import { formatLocalTime } from './system/SystemInfo';
import { simulationNowMs } from '../../core/SystemClock';
import { kernelHostname } from './KernelHostname';
import { VirtualFileSystem } from './VirtualFileSystem';
import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import { LinuxJournald } from './journal/LinuxJournald';
import type { JournaldStorage, ProcessFacts } from './journal/JournaldServer';
import { readJournaldConfig } from './journal/JournaldConfig';
import { JOURNALD_CONF_PATH, JOURNALD_CONF_TEXT, UBUNTU_SYSLOG_DROP_IN_PATH, UBUNTU_SYSLOG_DROP_IN_TEXT } from './journal/JournaldDefaults';
import type { JournalRecord } from './journal/JournalRecord';
import { fieldValues } from './journal/JournalRecord';
import { kernelBootMessages, kernelCommandLine, defaultKernelBootFacts, type KernelBootFacts } from './boot/KernelBootLog';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';
import { SYSLOG_FACILITY } from '@/network/syslog/types';
import { SyslogForwardSocket } from './syslog/SyslogForwardSocket';
import type { AppendCreation, AppendDescriptor, AppendFailure } from './VirtualFileSystem';

// ── Priority levels (syslog) ─────────────────────────────────────
const PRIORITY_NAMES: Record<string, number> = {
  emerg: 0, emergency: 0, panic: 0, alert: 1, crit: 2, err: 3, error: 3,
  warning: 4, warn: 4, notice: 5, info: 6, debug: 7,
};
const FACILITY_NAMES: Record<string, number> = SYSLOG_FACILITY;

// ── Journal entry ────────────────────────────────────────────────
interface JournalEntry {
  timestamp: Date;
  monotonicUsec: number;  // microseconds since boot
  priority: number;
  displayPid?: boolean;
  facility: number;
  unit: string;
  tag: string;
  message: string;
  pid: number;
  hostname: string;
  transport: string;
  senderPid: number;
  senderUid: number;
  senderGid: number;
}

// ── Dmesg entry ──────────────────────────────────────────────────
interface DmesgEntry {
  offsetSec: number;  // seconds since boot (float)
  level: number;
  message: string;
}

export function fmtSyslogTimestamp(d: Date, zone?: string): string {
  return formatLocalTime('%b %e %H:%M:%S', d.getTime(), zone);
}

export function fmtHumanDate(d: Date, zone?: string): string {
  return formatLocalTime('%a %b %e %H:%M:%S %Y', d.getTime(), zone);
}

export class LinuxLogManager {
  readonly journald: LinuxJournald;
  private readonly syntheticFacts = new Map<number, ProcessFacts>();
  private processProbe: ((pid: number) => ProcessFacts | null) | null = null;
  private seeding = true;
  private dmesgBuffer: DmesgEntry[] = [];
  private bootTime: Date;
  private nextPid = 100;
  readonly syslogSocket = new SyslogForwardSocket();
  consoleLogLevel = 4;
  private busUnsub: Unsubscribe[] = [];
  private attachedBus: IEventBus | null = null;
  private attachedDeviceId: string | null = null;
  private readonly SEVERITY_NAME = [
    'emergencies', 'alerts', 'critical', 'errors',
    'warnings', 'notifications', 'informational', 'debugging',
  ] as const;

  /**
   * Le noyau que les lignes d'amorcage de `dmesg` nomment. Elles en
   * portaient une copie ecrite en dur (`5.15.0-generic`), differente de
   * ce que `uname -r` annonce et de ce que `last` annoncait encore.
   */
  private kernelRelease = '5.15.0-130-generic';

  private readonly bootFacts: KernelBootFacts;

  private nowMs: () => number = simulationNowMs;

  setClock(now: () => number): void { this.nowMs = now; }

  private zoneName: () => string | undefined = () => undefined;
  setZone(zone: () => string | undefined): void { this.zoneName = zone; }

  registerProcessFacts(pid: number, facts: ProcessFacts): void { this.syntheticFacts.set(pid, facts); }

  syncJournalFiles(): void {
    const directory = this.journald.directory;
    this.vfs.mkdirp(directory, 0o2755, 0, 4);
    const wanted = new Set(this.journald.fileInfos().map((info) => info.path));
    for (const entry of this.vfs.listDirectory(directory) ?? []) {
      const path = `${directory}/${entry.name}`;
      if (entry.name.endsWith('.journal') && !wanted.has(path)) this.vfs.deleteFile(path);
    }
    for (const path of wanted) if (!this.vfs.exists(path)) this.vfs.writeFile(path, '', 0, 4, 0o027, false, 8 * 1024 * 1024);
  }

  private pendingCgroup: string | null = null;

  private probeFacts(pid: number): ProcessFacts | null {
    const facts = this.processProbe?.(pid) ?? this.syntheticFacts.get(pid) ?? null;
    return facts !== null && this.pendingCgroup !== null ? { ...facts, cgroup: this.pendingCgroup } : facts;
  }

  writeKernelRing(content: string): boolean {
    let text = content;
    if (text.endsWith('\n')) text = text.slice(0, -1);
    text = text.slice(0, 1024);
    let priority = 4;
    const prefix = /^<(\d*)>/.exec(text);
    if (prefix !== null) {
      priority = (prefix[1] === '' ? 0 : Number(prefix[1])) & 0x3ff;
      text = text.slice(prefix[0].length);
    }
    if (priority >> 3 === 0) priority |= 8;
    const atMs = this.nowMs();
    this.journald.deliverKernel({ priority, message: text, monotonicUsec: Math.max(0, atMs * 1000 - this.bootTime.getTime() * 1000), realtimeUsec: atMs * 1000 });
    return true;
  }

  kernelRingRecords(): string {
    return this.journald.records().filter((record) => fieldValues(record, '_TRANSPORT').some((value) => new TextDecoder().decode(value) === 'kernel')).map((record) => {
      const level = new TextDecoder().decode(fieldValues(record, 'PRIORITY')[0] ?? new Uint8Array());
      const facility = new TextDecoder().decode(fieldValues(record, 'SYSLOG_FACILITY')[0] ?? new Uint8Array());
      const message = new TextDecoder().decode(fieldValues(record, 'MESSAGE')[0] ?? new Uint8Array());
      return `${(Number(facility) << 3) | Number(level)},${record.seqnum},${record.monotonicUsec},-;${message.replace(/\\/g, '\\x5c').replace(/\n/g, '\\x0a')}\n`;
    }).join('');
  }

  setProcessProbe(probe: (pid: number) => ProcessFacts | null): void { this.processProbe = probe; }

  constructor(private vfs: VirtualFileSystem, facts?: KernelBootFacts, private readonly machineId: () => string = () => '0'.repeat(32)) {
    this.bootFacts = facts ?? defaultKernelBootFacts();
    this.kernelRelease = this.bootFacts.kernelRelease;
    this.bootTime = new Date(simulationNowMs() - 30_000);
    this.vfs.mkdirp('/var/log/journal', 0o2755, 0, 4);
    this.journald = new LinuxJournald({
      nowUsec: () => this.nowMs() * 1000,
      bootUsec: () => this.bootTime.getTime() * 1000,
      machineId: () => this.machineId(),
      hostname: () => this.currentHostname(),
      probe: (pid) => this.probeFacts(pid),
      journaldPid: () => null,
      persistentStorage: () => this.persistentJournal(),
      diskFreeBytes: () => 20 * 1024 ** 3,
    });
    this.seedJournaldConfiguration();
    this.reloadJournaldConfig();
    this.journald.onRecord((record) => this.onJournalRecord(record));
    this.populateBootMessages();
    this.seeding = false;
    this.syncJournalFiles();
    this.vfs.registerWritableGeneratedFile('/dev/kmsg', () => this.kernelRingRecords(), (content) => this.writeKernelRing(content), 0o644, 0, 0);
  }

  private journaldStorage: JournaldStorage = 'auto';

  private persistentJournal(): boolean {
    if (this.journaldStorage === 'persistent') return true;
    if (this.journaldStorage === 'volatile') return false;
    return this.vfs.resolveInode('/var/log/journal') !== null;
  }

  private seedJournaldConfiguration(): void {
    if (!this.vfs.exists(JOURNALD_CONF_PATH)) this.vfs.writeFile(JOURNALD_CONF_PATH, JOURNALD_CONF_TEXT, 0, 0, 0o022);
    if (!this.vfs.exists(UBUNTU_SYSLOG_DROP_IN_PATH)) {
      this.vfs.mkdirp('/usr/lib/systemd/journald.conf.d', 0o755, 0, 0);
      this.vfs.writeFile(UBUNTU_SYSLOG_DROP_IN_PATH, UBUNTU_SYSLOG_DROP_IN_TEXT, 0, 0, 0o022);
    }
  }

  reloadJournaldConfig(journaldPid = 0): void {
    const readout = readJournaldConfig(this.vfs, this.kernelCommandLine());
    Object.assign(this.journald.settings, readout.settings);
    this.journaldStorage = readout.settings.storage;
    for (const diagnostic of readout.diagnostics) {
      this.submitLibcSyslog(SYSLOG_FACILITY.daemon << 3 | diagnostic.priority, 'systemd-journald', journaldPid, diagnostic.message, this.nowMs());
    }
  }

  /** La ligne de commande du noyau, celle que `/proc/cmdline` rend. */
  kernelCommandLine(): string {
    return kernelCommandLine(this.bootFacts.kernelRelease, this.bootFacts.rootPartition);
  }

  attachBus(bus: IEventBus, deviceId?: string): void {
    for (const off of this.busUnsub) off();
    this.busUnsub = [];
    this.attachedBus = bus;
    if (deviceId) this.attachedDeviceId = deviceId;
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
      hostname: this.currentHostname(),
    });
    return true;
  }

  submitLibcSyslog(priority: number, ident: string, pid: number, message: string, atMs: number): void {
    this.addEntry({
      priority: priority & 7,
      facility: priority >> 3,
      unit: '',
      tag: ident,
      message,
      pid,
      displayPid: false,
      hostname: this.currentHostname(),
    }, atMs);
  }

  /**
   * Append an authentication-facility record — the bridge the IAM layer uses
   * to keep `/var/log/auth.log` (and the journal) coherent with account
   * changes. `tag` is the responsible program (`useradd`, `passwd`, …).
   */
  allocatePid(): number {
    return this.nextPid++;
  }

  logAuth(tag: string, message: string, pid?: number, unit?: string, priority = 'info'): void {
    this.addEntry({
      priority: PRIORITY_NAMES[priority] ?? PRIORITY_NAMES.info,
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
      hostname: this.currentHostname(),
    });
  }

  /**
   * Append a daemon-facility record — used by the port subsystem to log a
   * socket bind / release the way systemd-journald notes a daemon opening
   * or closing its listening port.
   */
  logDaemon(tag: string, message: string, pid?: number, unit?: string): void {
    this.addEntry({
      priority: PRIORITY_NAMES.info,
      facility: FACILITY_NAMES.daemon,
      unit: unit ?? tag,
      tag,
      message,
      pid: pid ?? this.nextPid++,
      hostname: this.currentHostname(),
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
      hostname: this.currentHostname(),
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
      hostname: this.currentHostname(),
      ...(unit === 'systemd' ? {} : { unitField: unit.includes('.') ? unit : `${unit}.service` }),
    });
  }

  // ── dmesg command ──────────────────────────────────────────────
  executeDmesg(args: string[]): string {
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
      return `[${fmtHumanDate(ts, this.zoneName())}] ${e.message}`;
    }
    return `[${padToWidth(e.offsetSec.toFixed(6), 12, 'right')}] ${e.message}`;
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

  logService(unit: string, tag: string, message: string, pid: number, priority: number = PRIORITY_NAMES.info): void {
    this.addEntry({
      priority,
      facility: FACILITY_NAMES.daemon,
      unit,
      tag,
      message,
      pid,
      hostname: this.currentHostname(),
    });
  }

  private addEntry(opts: {
    priority: number; facility: number; unit: string;
    tag: string; message: string; pid: number; hostname: string;
    displayPid?: boolean; unitField?: string;
  }, atMs: number = this.nowMs()): void {
    const run = (): void => {
      if (opts.facility === FACILITY_NAMES.kern) {
        this.journald.deliverKernel({ priority: (opts.facility << 3) | opts.priority, message: opts.message, monotonicUsec: Math.max(0, atMs * 1000 - this.bootTime.getTime() * 1000), realtimeUsec: atMs * 1000 });
        return;
      }
      if (opts.unitField !== undefined) {
        this.deliverUnitMessage(opts, opts.unitField, atMs);
        return;
      }
      const pidPart = opts.pid > 0 && opts.displayPid !== false ? `[${opts.pid}]` : '';
      const datagram = `<${(opts.facility << 3) | opts.priority}>${fmtSyslogTimestamp(new Date(atMs), this.zoneName())} ${opts.tag}${pidPart}: ${opts.message}`;
      const known = opts.pid > 0 && this.probeFacts(opts.pid) !== null;
      if (opts.pid > 0 && !known) this.syntheticFacts.set(opts.pid, this.factsFor(opts.pid, opts.tag, opts.unit));
      this.pendingCgroup = opts.unit !== '' || opts.pid === 1 ? this.factsFor(opts.pid, opts.tag, opts.unit).cgroup : null;
      try {
        this.journald.deliverSyslog(new TextEncoder().encode(datagram), opts.pid > 0 ? { pid: opts.pid, uid: 0, gid: 0 } : null, null, atMs * 1000);
      } finally {
        this.pendingCgroup = null;
      }
    };
    this.journald.withStamp(atMs * 1000, run);
  }

  private deliverUnitMessage(opts: { priority: number; facility: number; tag: string; message: string; pid: number }, unit: string, atMs: number): void {
    const lines = [`PRIORITY=${opts.priority}`, `SYSLOG_FACILITY=${opts.facility}`, `SYSLOG_IDENTIFIER=${opts.tag}`, `UNIT=${unit}`, `MESSAGE=${opts.message}`];
    const known = this.probeFacts(opts.pid) !== null;
    if (!known) this.syntheticFacts.set(opts.pid, this.factsFor(opts.pid, opts.tag, ''));
    this.pendingCgroup = opts.pid === 1 ? '/init.scope' : null;
    try {
      this.journald.deliverNative(new TextEncoder().encode(`${lines.join('\n')}\n`), { pid: opts.pid, uid: 0, gid: 0 }, null, atMs * 1000);
    } finally {
      this.pendingCgroup = null;
    }
  }

  private factsFor(pid: number, tag: string, unit: string): ProcessFacts {
    const service = unit.replace(/\.service$/, '');
    let cgroup: string | null = null;
    if (pid === 1) cgroup = '/init.scope';
    else if (service !== '') cgroup = `/system.slice/${service}.service`;
    return { uid: 0, gid: 0, comm: tag.slice(0, 15), exe: null, cmdline: null, capeff: null, label: null, auditId: null, loginUid: null, cgroup, invocationId: null };
  }

  private entryOf(record: JournalRecord): JournalEntry {
    const text = (name: string): string | null => {
      const [value] = fieldValues(record, name);
      return value === undefined ? null : new TextDecoder().decode(value);
    };
    const number = (name: string, fallback: number): number => {
      const value = text(name);
      return value !== null && /^\d+$/.test(value) ? Number(value) : fallback;
    };
    const syslogPid = text('SYSLOG_PID');
    return {
      timestamp: new Date(Math.floor(record.realtimeUsec / 1000)),
      monotonicUsec: record.monotonicUsec,
      priority: number('PRIORITY', 6),
      facility: number('SYSLOG_FACILITY', 1),
      unit: text('_SYSTEMD_UNIT') ?? '',
      tag: text('SYSLOG_IDENTIFIER') ?? text('_COMM') ?? '',
      message: text('MESSAGE') ?? '',
      pid: syslogPid !== null ? number('SYSLOG_PID', 0) : 0,
      displayPid: syslogPid !== null,
      hostname: text('_HOSTNAME') ?? this.currentHostname(),
      transport: text('_TRANSPORT') ?? '',
      senderPid: number('_PID', 0),
      senderUid: number('_UID', 0),
      senderGid: number('_GID', 0),
    };
  }

  private journalEntries(): JournalEntry[] {
    return this.journald.records().map((record) => this.entryOf(record));
  }

  private onJournalRecord(record: JournalRecord): void {
    const entry = this.entryOf(record);
    const pidPart = entry.pid > 0 && entry.displayPid !== false ? `[${entry.pid}]` : '';
    const settings = this.journald.settings;
    if (settings.forwardToSyslog && entry.priority <= settings.maxLevelSyslog) this.syslogSocket.deliver({
      text: `<${(entry.facility << 3) | entry.priority}>${fmtSyslogTimestamp(entry.timestamp, this.zoneName())} ${entry.tag}${pidPart}: ${entry.message}`,
      pid: entry.senderPid,
      uid: entry.senderUid,
      gid: entry.senderGid,
      receivedAtMs: entry.timestamp.getTime(),
    });
    if (this.seeding) return;
    if (entry.transport === 'kernel') {
      const dEntry: DmesgEntry = {
        offsetSec: (entry.timestamp.getTime() - this.bootTime.getTime()) / 1000,
        level: entry.priority,
        message: entry.message,
      };
      this.dmesgBuffer.push(dEntry);
      this.emitToDmesgFollowers(dEntry);
    }
    if (!this.syslogSocket.isAttached) return;
    if (this.attachedBus && this.attachedDeviceId) {
      const sevName = this.SEVERITY_NAME[entry.priority] ?? 'informational';
      this.attachedBus.publish({
        topic: 'device.syslog.entry',
        payload: {
          deviceId: this.attachedDeviceId,
          severity: sevName, severityNum: entry.priority,
          tag: entry.tag, message: entry.message, ts: entry.timestamp.getTime(),
        },
      });
    }
  }

  private formatSyslogLine(entry: JournalEntry): string {
    const ts = fmtSyslogTimestamp(entry.timestamp, this.zoneName());
    const pidPart = entry.pid > 0 && entry.displayPid !== false ? `[${entry.pid}]` : '';
    return `${ts} ${entry.hostname} ${entry.tag}${pidPart}: ${entry.message}`;
  }

  private readonly heldFiles = new Set<AppendDescriptor>();
  private readonly namedDescriptors = new Map<string, AppendDescriptor>();

  private descriptorSink?: {
    open(path: string): void;
    close(path: string): void;
    closeAll(): void;
  };

  attachDescriptorSink(sink: { open(path: string): void; close(path: string): void; closeAll(): void }): void {
    this.descriptorSink = sink;
  }

  holdFile(path: string, creation: AppendCreation): { readonly handle: AppendDescriptor; readonly release: () => void } | AppendFailure {
    const opened = this.vfs.openAppend(path, creation);
    if ('error' in opened) return opened;
    this.heldFiles.add(opened);
    this.descriptorSink?.open(opened.path);
    return {
      handle: opened,
      release: () => {
        this.heldFiles.delete(opened);
        this.descriptorSink?.close(opened.path);
      },
    };
  }

  appendLine(path: string, line: string): void {
    let descriptor = this.namedDescriptors.get(path);
    if (descriptor !== undefined && descriptor.unlinked && this.vfs.exists(path)) {
      this.heldFiles.delete(descriptor);
      descriptor = undefined;
    }
    if (descriptor === undefined) {
      const held = this.holdFile(path, { mode: 0o640, uid: 0, gid: 4, directoryMode: 0o755, directoryUid: 0, directoryGid: 0, createDirectories: true });
      if ('error' in held) return;
      descriptor = held.handle;
      this.namedDescriptors.set(path, descriptor);
    }
    descriptor.append(`${line}\n`);
  }

  deletedLogHandles(): Array<{ path: string; lostLines: number; lostBytes: number }> {
    const out: Array<{ path: string; lostLines: number; lostBytes: number }> = [];
    for (const held of this.heldFiles) {
      if (held.lostLines > 0 && held.unlinked) out.push({ path: held.path, lostLines: held.lostLines, lostBytes: held.lostBytes });
    }
    return out;
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
    return kernelHostname(this.vfs);
  }

  // ── Boot message population ────────────────────────────────────
  private populateBootMessages(): void {
    const bt = this.bootTime;

    for (const km of kernelBootMessages(this.bootFacts)) {
      this.dmesgBuffer.push({ offsetSec: km.offset, level: km.level, message: km.msg });
      this.addEntry({ priority: km.level, facility: FACILITY_NAMES.kern, unit: '', tag: 'kernel', message: km.msg, pid: 0, hostname: this.currentHostname() }, bt.getTime() + km.offset * 1000);
    }

    this.journald.withStamp(bt.getTime() * 1000 + 2_000_000, () => this.journald.start());

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
      const started = /^Started (\S+\.service)/.exec(sm.msg);
      this.addEntry({ priority: sm.pri, facility: sm.fac, unit: sm.unit, tag: sm.tag, message: sm.msg, pid: sm.pid, hostname: this.currentHostname(), ...(started ? { unitField: started[1] } : {}) }, bt.getTime() + offset * 1000);
    }

    // No seeded sshd lines here, deliberately.
    //
    // `Server listening on 0.0.0.0 port 22.` is already produced by the
    // real event — `tcp.listener.changed` when the ssh unit binds its
    // socket — and `PortActivityLogProjection` writes it with the pid the
    // daemon actually has in the process table. Seeding a copy meant the
    // same machine showed that line twice, once under an invented
    // `sshd[1234]` that `ps aux | grep sshd` never matched.
    //
    // Son jumeau IPv6 (`Server listening on :: port 22.`) n'est pas
    // ensemencé non plus, et pour la même raison : il vient de
    // l'événement réel. Il l'a d'ailleurs longtemps été à tort — cette
    // ligne était absente parce que le simulateur ne liait aucune écoute
    // IPv6, et l'annoncer aurait décrit une socket inexistante. Depuis
    // que `attachSshTcpListeners` ouvre les deux familles
    // (docs/PRD-Sockets-Une-Seule-Verite.md §P2b), la socket existe, donc
    // la ligne existe — écrite par le même pid que sa jumelle v4.

    // Auth/logind messages
    const logindPid = 456;
    const authMsgs = [
      'New seat seat0.',
      'Watching system buttons on /dev/input/event0.',
    ];
    offset = 2.5;
    for (const msg of authMsgs) {
      offset += 0.1;
      this.addEntry({ priority: 6, facility: 4, unit: 'systemd-logind', tag: 'systemd-logind', message: msg, pid: logindPid, hostname: this.currentHostname() }, bt.getTime() + offset * 1000);
    }

    // Write initial log files
    this.writeInitialLogFiles();
  }

  private writeInitialLogFiles(): void {
    const bootLines = this.journalEntries()
      .filter(e => e.tag === 'systemd' || e.tag === 'kernel')
      .map(e => this.formatSyslogLine(e));
    this.vfs.createFileAt('/var/log/boot.log', bootLines.join('\n') + '\n', 0o640, 0, 4);
  }
}
