/**
 * PSEventLogProvider — In-memory Windows Event Log simulation.
 *
 * Supports:
 *   - Get-EventLog -List / -LogName / -Newest / -EntryType / -Source
 *   - Write-EventLog (adds entries to the store)
 *   - Clear-EventLog (empties a log)
 *   - New-EventLog (registers a source)
 *   - Get-WinEvent -LogName / -MaxEvents / -ListLog
 *   - Limit-EventLog (silently accepted)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type EntryType = 'Information' | 'Warning' | 'Error' | 'SuccessAudit' | 'FailureAudit';

export interface EventLogEntry {
  index: number;
  timeGenerated: Date;
  entryType: EntryType;
  source: string;
  eventId: number;
  category: string;
  message: string;
  /** Structured EventData fields (TargetUserName, SubjectUserName, IpAddress, Status, …) as real Windows Security events carry — surfaced via Get-WinEvent's ToXml(). */
  data?: Record<string, string>;
}

export interface EventLogMetadata {
  logName: string;
  maxSizeKB: number;
  overflow: 'OverwriteOlder' | 'DoNotOverwrite' | 'OverwriteAsNeeded';
  entries: EventLogEntry[];
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

function makeDate(daysAgo: number, hoursAgo = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(d.getHours() - hoursAgo);
  return d;
}

/** Per-device RecordId counters. A shared module-level counter made the
 *  same logical event get different RecordIds on two devices (the second
 *  device's numbering was offset by the first device's entry count) —
 *  breaking pc/server transcript coherence. Each provider now numbers
 *  its own entries from a fixed base. */
const RECORD_ID_BASE = 1000;

function entry(
  next: () => number,
  type: EntryType, source: string, eventId: number, message: string,
  daysAgo: number, hoursAgo = 0, data?: Record<string, string>,
): EventLogEntry {
  return {
    index: next(),
    timeGenerated: makeDate(daysAgo, hoursAgo),
    entryType: type,
    source,
    eventId,
    category: '(0)',
    message,
    data,
  };
}

function buildSystemLog(next: () => number): EventLogEntry[] {
  return [
    entry(next, 'Information', 'Microsoft-Windows-Kernel-General', 12, 'The operating system started at system time 2024-01-15T08:00:00.', 7),
    entry(next, 'Information', 'Microsoft-Windows-Kernel-Boot', 20, 'The last shutdown\'s success status was true.', 7),
    entry(next, 'Warning',     'Microsoft-Windows-Time-Service', 36, 'The time service has not synchronized the system time for 86400 seconds.', 5),
    entry(next, 'Information', 'Service Control Manager', 7036, 'The Windows Update service entered the running state.', 4),
    entry(next, 'Information', 'Service Control Manager', 7036, 'The DHCP Client service entered the running state.', 3),
    entry(next, 'Error',       'Disk', 7, 'The device, \\Device\\Harddisk0\\DR0, has a bad block.', 2),
    entry(next, 'Information', 'Microsoft-Windows-Winlogon', 7001, 'User Logon Notification for Customer Experience Improvement Program.', 1),
    entry(next, 'Information', 'Microsoft-Windows-Kernel-General', 1, 'The system uptime is 86400 seconds.', 0, 12),
    entry(next, 'Warning',     'Microsoft-Windows-Power-Troubleshooter', 1, 'The system has returned from a low power state.', 0, 6),
    entry(next, 'Information', 'EventLog', 6005, 'The Event log service was started.', 0, 2),
  ];
}

function buildApplicationLog(next: () => number): EventLogEntry[] {
  return [
    entry(next, 'Information', 'Windows Error Reporting', 1001, 'Fault bucket 0, type 0 — Event Name: APPCRASH.', 14),
    entry(next, 'Information', 'MsiInstaller', 11707, 'Product: Microsoft Visual C++ Redistributable — Installation completed successfully.', 10),
    entry(next, 'Warning',     'Application Error', 1000, 'Faulting application name: explorer.exe.', 7),
    entry(next, 'Information', 'SecurityCenter', 1, 'The Windows Security Center Service has started.', 5),
    entry(next, 'Error',       'Application Hang', 1002, 'The program svchost.exe stopped interacting with Windows.', 3),
    entry(next, 'Information', '.NET Runtime', 1026, '.NET Runtime version 4.0.30319 — Application crashed.', 1),
  ];
}

function buildSecurityLog(next: () => number): EventLogEntry[] {
  return [
    entry(next, 'SuccessAudit', 'Microsoft-Windows-Security-Auditing', 4624, 'An account was successfully logged on.', 1),
    entry(next, 'SuccessAudit', 'Microsoft-Windows-Security-Auditing', 4624, 'An account was successfully logged on.', 1),
    entry(next, 'FailureAudit', 'Microsoft-Windows-Security-Auditing', 4625, 'An account failed to log on.', 1),
    entry(next, 'SuccessAudit', 'Microsoft-Windows-Security-Auditing', 4648, 'A logon was attempted using explicit credentials.', 0),
    entry(next, 'SuccessAudit', 'Microsoft-Windows-Security-Auditing', 4672,
      'Special privileges assigned to new logon.', 0, 0,
      { SubjectUserName: 'SYSTEM', SubjectDomainName: 'NT AUTHORITY',
        PrivilegeList: BOOT_PRIVILEGE_LIST }),
    // 4673 — un appel de service privilégié. Le noyau en émet au
    // démarrage (l'ouverture de session du service local en fait un), et
    // ce n'est pas une entrée de décor : c'est le même mécanisme que les
    // 4624/4672 déjà présents ici.
    entry(next, 'SuccessAudit', 'Microsoft-Windows-Security-Auditing', 4673,
      'A privileged service was called.', 0, 1,
      { SubjectUserName: 'SYSTEM', SubjectDomainName: 'NT AUTHORITY',
        Service: 'Security', PrivilegeList: 'SeSecurityPrivilege',
        ProcessName: 'C:\\Windows\\System32\\lsass.exe' }),
  ];
}

/**
 * Les privilèges qu'un jeton d'administrateur reçoit à l'ouverture de
 * session, et que 4672 énumère. La liste est celle que Windows nomme —
 * `SeDebugPrivilege` et `SeImpersonatePrivilege` en sont les deux plus
 * surveillées, parce qu'elles suffisent à prendre la main sur un autre
 * processus.
 */
export const BOOT_PRIVILEGE_LIST = [
  'SeSecurityPrivilege', 'SeBackupPrivilege', 'SeRestorePrivilege',
  'SeTakeOwnershipPrivilege', 'SeDebugPrivilege', 'SeSystemEnvironmentPrivilege',
  'SeLoadDriverPrivilege', 'SeImpersonatePrivilege',
].join('\n\t\t\t');

/** Assumed average serialized size of one entry, used to derive a fillable entry-count cap from `maxSizeKB` (CrashOnAuditFail, PRD-Auditpol.md §2.1 P10). */
const AVG_ENTRY_BYTES = 500;

// ─── Provider ────────────────────────────────────────────────────────────────

/** Directory holding the materialised `.evtx` log files. */
const EVTX_DIR = 'C:\\Windows\\System32\\winevt\\Logs';

/** The slice of the Windows filesystem the provider materialises logs onto. */
export interface EvtxFilesystem {
  mkdirp(absPath: string): void;
  createFile(absPath: string, content: string): { ok: boolean; error?: string };
  /** Optionnel : `wevtutil epl` refuse d'écraser sans `/ow:true`. */
  exists?(absPath: string): boolean;
}

export class PSEventLogProvider {
  private bus: import('@/events/EventBus').IEventBus | null = null;
  private deviceId: string | null = null;
  attachBus(bus: import('@/events/EventBus').IEventBus, deviceId: string): void {
    this.bus = bus;
    this.deviceId = deviceId;
  }
  /** Windows Event Forwarding hook (PRD-Wecutil.md §2.1 P4) — called with
   *  every freshly-written entry so the owning device can dial any
   *  collector with a matching active subscription. `ForwardedEvents`
   *  itself is excluded so a received event is never re-forwarded. */
  private forwarder: ((logName: string, entry: EventLogEntry) => void) | null = null;
  attachForwarder(fn: (logName: string, entry: EventLogEntry) => void): void {
    this.forwarder = fn;
  }
  private logs: Map<string, EventLogMetadata>;
  /** Per-instance RecordId counter (see RECORD_ID_BASE note above). */
  private recordId = RECORD_ID_BASE;
  private nextIndex = (): number => this.recordId++;
  /** Windows filesystem the `.evtx` files are written onto, when wired. */
  private fs: EvtxFilesystem | null = null;

  constructor() {
    this.logs = new Map();
    this.logs.set('system', {
      logName: 'System', maxSizeKB: 20480, overflow: 'OverwriteOlder',
      entries: buildSystemLog(this.nextIndex),
    });
    this.logs.set('application', {
      logName: 'Application', maxSizeKB: 20480, overflow: 'OverwriteOlder',
      entries: buildApplicationLog(this.nextIndex),
    });
    this.logs.set('security', {
      logName: 'Security', maxSizeKB: 131072, overflow: 'OverwriteOlder',
      entries: buildSecurityLog(this.nextIndex),
    });
    this.logs.set('setup', {
      logName: 'Setup', maxSizeKB: 1028, overflow: 'OverwriteAsNeeded',
      entries: [],
    });
    // Le canal où PowerShell dépose ses 4103/4104. Il existe sur tout
    // Windows moderne, vide tant que la stratégie de journalisation
    // n'est pas posée — un journal absent et un journal vide ne se
    // disent pas de la même façon à qui l'interroge.
    this.logs.set('microsoft-windows-powershell/operational', {
      logName: 'Microsoft-Windows-PowerShell/Operational',
      maxSizeKB: 15360, overflow: 'OverwriteAsNeeded',
      entries: [],
    });
    this.logs.set('forwardedevents', {
      logName: 'ForwardedEvents', maxSizeKB: 20480, overflow: 'OverwriteOlder',
      entries: [],
    });
  }

  // ─── Get-EventLog ─────────────────────────────────────────────────

  getEventLogList(): string {
    const lines: string[] = [
      '',
      '  Max(K) Retain OverflowAction        Entries Log',
      '  ------ ------ --------------        ------- ---',
    ];
    for (const [, meta] of this.logs) {
      const entries = String(meta.entries.length).padStart(7);
      const maxK = String(meta.maxSizeKB).padStart(7);
      lines.push(`${maxK}      0 ${meta.overflow.padEnd(22)}${entries} ${meta.logName}`);
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Structured accessor used by the new ICmdlet path. Same filtering as
   * getEventLog() but returns the raw entries instead of a formatted string.
   */
  getEntriesStructured(logName: string, opts: { newest?: number; entryType?: string; source?: string } = {}): EventLogEntry[] | null {
    const meta = this.logs.get(logName.toLowerCase());
    if (!meta) return null;
    let entries = [...meta.entries].reverse();
    if (opts.entryType) {
      const et = opts.entryType.toLowerCase();
      entries = entries.filter(e => e.entryType.toLowerCase() === et);
    }
    if (opts.source) {
      const src = opts.source.toLowerCase();
      entries = entries.filter(e => e.source.toLowerCase().includes(src));
    }
    if (opts.newest !== undefined) entries = entries.slice(0, opts.newest);
    return entries;
  }

  /** All known logs as structured metadata. */
  getAllLogsStructured(): Array<{ logName: string; entries: number; maxSizeKB: number }> {
    return Array.from(this.logs.values()).map(m => ({
      logName: m.logName,
      entries: m.entries.length,
      maxSizeKB: m.maxSizeKB,
    }));
  }

  getEventLog(logName: string, opts: { newest?: number; entryType?: string; source?: string }): string {
    const key = logName.toLowerCase();
    const meta = this.logs.get(key);
    if (!meta) return `Get-EventLog : Cannot open log "${logName}". The log name "${logName}" does not exist on this computer.`;

    let entries = [...meta.entries].reverse(); // newest first

    if (opts.entryType) {
      const et = opts.entryType.toLowerCase();
      entries = entries.filter(e => e.entryType.toLowerCase() === et);
    }
    if (opts.source) {
      const src = opts.source.toLowerCase();
      entries = entries.filter(e => e.source.toLowerCase().includes(src));
    }
    if (opts.newest !== undefined) {
      entries = entries.slice(0, opts.newest);
    }

    if (entries.length === 0) return '';

    const lines: string[] = [
      '',
      '   Index Time          EntryType   Source                 InstanceID Message',
      '   ----- ----          ---------   ------                 ---------- -------',
    ];
    for (const e of entries) {
      const time = this.formatTime(e.timeGenerated);
      const type = e.entryType.substring(0, 11).padEnd(11);
      const source = e.source.substring(0, 22).padEnd(22);
      const id = String(e.eventId).padStart(10);
      const msg = e.message.substring(0, 40) + (e.message.length > 40 ? '...' : '');
      lines.push(`${String(e.index).padStart(7)} ${time} ${type} ${source} ${id} ${msg}`);
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Wire the Windows filesystem so each event log is materialised as a
   * `.evtx` file under `winevt\Logs`. Idempotent; an initial render runs
   * immediately so the files exist from first boot.
   */
  attachFilesystem(fs: EvtxFilesystem): void {
    this.fs = fs;
    this.fs.mkdirp(EVTX_DIR);
    this.materialize();
  }

  /**
   * `wevtutil epl <journal> <fichier>` — écrit une copie du journal à
   * l'emplacement demandé, dans le même format que les `.evtx` que le
   * système matérialise déjà sous `winevt\Logs`. C'est bien un export :
   * le fichier existe ensuite et se relit, il n'est pas seulement
   * annoncé.
   *
   * Rend `null` en cas de succès — `wevtutil` réussi n'écrit rien sur la
   * sortie — et le refus réel sinon.
   */
  exportLog(logName: string, destination: string, overwrite: boolean): string | null {
    const meta = this.logs.get(logName.toLowerCase());
    if (!meta) {
      return `Failed to export log ${logName}. The specified channel could not be found.`;
    }
    if (!this.fs) {
      return `Failed to export log ${logName}. The system cannot find the path specified.`;
    }
    if (!overwrite && this.fs.exists?.(destination)) {
      return `Failed to export log ${logName}. The file exists.`;
    }
    const parent = destination.replace(/\\[^\\]*$/, '');
    if (parent && parent !== destination) this.fs.mkdirp(parent);
    this.fs.createFile(destination, renderEvtx(meta));
    return null;
  }

  /** Re-render every event log to its `.evtx` file (no-op when unwired). */
  private materialize(): void {
    if (!this.fs) return;
    for (const meta of this.logs.values()) {
      this.fs.createFile(`${EVTX_DIR}\\${meta.logName}.evtx`, renderEvtx(meta));
    }
  }

  /**
   * L'horloge de l'hôte. Par défaut celle du poste qui exécute — mais un
   * `WindowsPC` a la sienne, simulée, et c'est elle que `Get-Date`
   * consulte. Tant que le journal horodatait avec `new Date()`, les deux
   * ne parlaient pas du même instant : un `Get-WinEvent -FilterHashtable
   * @{ StartTime = (Get-Date).AddHours(-24) }` ne retrouvait aucun
   * événement que la machine venait pourtant d'écrire. Deux commandes du
   * même système ne peuvent pas être en désaccord sur « maintenant ».
   */
  now: () => number = () => Date.now();

  /**
   * Bascule le journal sur l'horloge de l'hôte, et **décale les entrées
   * déjà présentes** du même écart.
   *
   * Les entrées de démarrage sont construites relativement à l'instant
   * de construction (« il y a sept jours »…). Poser l'horloge sans les
   * décaler les laisserait dans un autre référentiel que tout ce qui
   * s'écrit ensuite ; le même décalage appliqué à toutes conserve
   * exactement leur espacement.
   */
  attachClock(now: () => number): void {
    const shift = now() - Date.now();
    this.now = now;
    if (shift === 0) return;
    for (const meta of this.logs.values()) {
      for (const e of meta.entries) {
        e.timeGenerated = new Date(e.timeGenerated.getTime() + shift);
      }
    }
  }

  writeEventLog(logName: string, source: string, eventId: number, entryType: EntryType, message: string, data?: Record<string, string>): string {
    const key = logName.toLowerCase();
    if (!this.logs.has(key)) return `Write-EventLog : Cannot open log "${logName}". The log does not exist.`;
    const meta = this.logs.get(key)!;
    const ts = new Date(this.now());
    const entry: EventLogEntry = {
      index: this.nextIndex(),
      timeGenerated: ts,
      entryType,
      source,
      eventId,
      category: '(0)',
      message,
      data,
    };
    meta.entries.push(entry);
    this.materialize();
    if (this.forwarder && key !== 'forwardedevents') this.forwarder(meta.logName, entry);
    if (this.bus && this.deviceId) {
      const sevMap: Record<EntryType, { name: 'informational' | 'warnings' | 'errors' | 'critical' | 'notifications'; num: number }> = {
        Information: { name: 'informational', num: 6 },
        Warning: { name: 'warnings', num: 4 },
        Error: { name: 'errors', num: 3 },
        SuccessAudit: { name: 'notifications', num: 5 },
        FailureAudit: { name: 'warnings', num: 4 },
      };
      const sev = sevMap[entryType];
      this.bus.publish({
        topic: 'device.syslog.entry',
        payload: {
          deviceId: this.deviceId,
          severity: sev.name, severityNum: sev.num,
          tag: source, message,
          ts: ts.getTime(),
        },
      });
    }
    return '';
  }

  clearEventLog(logName: string): string {
    const key = logName.toLowerCase();
    if (!this.logs.has(key)) return `Clear-EventLog : No log with name "${logName}" was found.`;
    this.logs.get(key)!.entries = [];
    this.materialize();
    return '';
  }

  newEventLog(logName: string, source: string): string {
    // Register source — in reality this creates a registry entry.
    // We just silently accept it (or create the log if missing).
    const key = logName.toLowerCase();
    if (!this.logs.has(key)) {
      this.logs.set(key, {
        logName,
        maxSizeKB: 1028,
        overflow: 'OverwriteAsNeeded',
        entries: [],
      });
    }
    return '';
  }

  limitEventLog(logName: string, opts: { maximumSizeKB?: number; overflowAction?: EventLogMetadata['overflow'] } = {}): string {
    const key = logName.toLowerCase();
    const meta = this.logs.get(key);
    if (!meta) return `Limit-EventLog : No log with name "${logName}" was found.`;
    if (opts.maximumSizeKB !== undefined) meta.maxSizeKB = opts.maximumSizeKB;
    if (opts.overflowAction !== undefined) meta.overflow = opts.overflowAction;
    return '';
  }

  /**
   * True when `logName` has reached its (derived) entry-count cap AND its
   * retention policy forbids overwriting — the two preconditions real
   * Windows checks before halting on `CrashOnAuditFail`
   * (PRD-Auditpol.md §2.1 P10).
   */
  isFullAndProtected(logName: string): boolean {
    const meta = this.logs.get(logName.toLowerCase());
    if (!meta) return false;
    if (meta.overflow !== 'DoNotOverwrite') return false;
    const maxEntries = Math.max(1, Math.floor((meta.maxSizeKB * 1024) / AVG_ENTRY_BYTES));
    return meta.entries.length >= maxEntries;
  }

  // ─── Get-WinEvent ─────────────────────────────────────────────────

  getWinEventList(): string {
    const lines: string[] = ['', 'LogName                                  RecordCount', '-------                                  -----------'];
    for (const [, meta] of this.logs) {
      lines.push(`${meta.logName.padEnd(41)}${String(meta.entries.length).padStart(11)}`);
    }
    return lines.join('\n') + '\n';
  }

  getWinEvent(logName: string, maxEvents?: number): string {
    const key = logName.toLowerCase();
    const meta = this.logs.get(key);
    if (!meta) return `Get-WinEvent : No events were found that match the specified selection criteria.`;

    let entries = [...meta.entries].reverse();
    if (maxEvents !== undefined) entries = entries.slice(0, maxEvents);
    if (entries.length === 0) return 'Get-WinEvent : No events were found that match the specified selection criteria.';

    const lines: string[] = [
      '',
      'TimeCreated                     Id LevelDisplayName Message',
      '-----------                     -- ---------------- -------',
    ];
    for (const e of entries) {
      const time = e.timeGenerated.toISOString().replace('T', ' ').substring(0, 19);
      const level = e.entryType === 'Error' ? 'Error' :
        e.entryType === 'Warning' ? 'Warning' : 'Information';
      const msg = e.message.substring(0, 30) + '...';
      lines.push(`${time.padEnd(32)}${String(e.eventId).padStart(4)} ${level.padEnd(17)}${msg}`);
    }
    return lines.join('\n') + '\n';
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private formatTime(d: Date): string {
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hr = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${mo}/${day} ${hr}:${min}`;
  }
}

/**
 * Render an event log to the text representation written to its `.evtx`
 * file. Real `.evtx` is a binary format; the simulator keeps a faithful,
 * `type`-able plain-text projection of the record stream instead.
 */
function renderEvtx(meta: EventLogMetadata): string {
  const lines = [
    `# Windows Event Log: ${meta.logName}`,
    `# Records: ${meta.entries.length}  MaxSize: ${meta.maxSizeKB} KB  Retention: ${meta.overflow}`,
    '',
  ];
  for (const e of meta.entries) {
    lines.push(
      `Record #${e.index}  ${e.timeGenerated.toISOString()}  [${e.entryType}]`,
      `  Source: ${e.source}  Event ID: ${e.eventId}  Category: ${e.category}`,
      `  ${e.message.split('\n')[0]}`,
      '',
    );
  }
  return lines.join('\n');
}
