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

let globalIndex = 1000;
function nextIndex(): number { return globalIndex++; }

function entry(
  type: EntryType, source: string, eventId: number, message: string,
  daysAgo: number, hoursAgo = 0,
): EventLogEntry {
  return {
    index: nextIndex(),
    timeGenerated: makeDate(daysAgo, hoursAgo),
    entryType: type,
    source,
    eventId,
    category: '(0)',
    message,
  };
}

function buildSystemLog(): EventLogEntry[] {
  return [
    entry('Information', 'Microsoft-Windows-Kernel-General', 12, 'The operating system started at system time 2024-01-15T08:00:00.', 7),
    entry('Information', 'Microsoft-Windows-Kernel-Boot', 20, 'The last shutdown\'s success status was true.', 7),
    entry('Warning',     'Microsoft-Windows-Time-Service', 36, 'The time service has not synchronized the system time for 86400 seconds.', 5),
    entry('Information', 'Service Control Manager', 7036, 'The Windows Update service entered the running state.', 4),
    entry('Information', 'Service Control Manager', 7036, 'The DHCP Client service entered the running state.', 3),
    entry('Error',       'Disk', 7, 'The device, \\Device\\Harddisk0\\DR0, has a bad block.', 2),
    entry('Information', 'Microsoft-Windows-Winlogon', 7001, 'User Logon Notification for Customer Experience Improvement Program.', 1),
    entry('Information', 'Microsoft-Windows-Kernel-General', 1, 'The system uptime is 86400 seconds.', 0, 12),
    entry('Warning',     'Microsoft-Windows-Power-Troubleshooter', 1, 'The system has returned from a low power state.', 0, 6),
    entry('Information', 'EventLog', 6005, 'The Event log service was started.', 0, 2),
  ];
}

function buildApplicationLog(): EventLogEntry[] {
  return [
    entry('Information', 'Windows Error Reporting', 1001, 'Fault bucket 0, type 0 — Event Name: APPCRASH.', 14),
    entry('Information', 'MsiInstaller', 11707, 'Product: Microsoft Visual C++ Redistributable — Installation completed successfully.', 10),
    entry('Warning',     'Application Error', 1000, 'Faulting application name: explorer.exe.', 7),
    entry('Information', 'SecurityCenter', 1, 'The Windows Security Center Service has started.', 5),
    entry('Error',       'Application Hang', 1002, 'The program svchost.exe stopped interacting with Windows.', 3),
    entry('Information', '.NET Runtime', 1026, '.NET Runtime version 4.0.30319 — Application crashed.', 1),
  ];
}

function buildSecurityLog(): EventLogEntry[] {
  return [
    entry('SuccessAudit', 'Microsoft-Windows-Security-Auditing', 4624, 'An account was successfully logged on.', 1),
    entry('SuccessAudit', 'Microsoft-Windows-Security-Auditing', 4624, 'An account was successfully logged on.', 1),
    entry('FailureAudit', 'Microsoft-Windows-Security-Auditing', 4625, 'An account failed to log on.', 1),
    entry('SuccessAudit', 'Microsoft-Windows-Security-Auditing', 4648, 'A logon was attempted using explicit credentials.', 0),
    entry('SuccessAudit', 'Microsoft-Windows-Security-Auditing', 4672, 'Special privileges assigned to new logon.', 0),
  ];
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class PSEventLogProvider {
  private logs: Map<string, EventLogMetadata>;

  constructor() {
    this.logs = new Map();
    this.logs.set('system', {
      logName: 'System', maxSizeKB: 20480, overflow: 'OverwriteOlder',
      entries: buildSystemLog(),
    });
    this.logs.set('application', {
      logName: 'Application', maxSizeKB: 20480, overflow: 'OverwriteOlder',
      entries: buildApplicationLog(),
    });
    this.logs.set('security', {
      logName: 'Security', maxSizeKB: 131072, overflow: 'OverwriteOlder',
      entries: buildSecurityLog(),
    });
    this.logs.set('setup', {
      logName: 'Setup', maxSizeKB: 1028, overflow: 'OverwriteAsNeeded',
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

  writeEventLog(logName: string, source: string, eventId: number, entryType: EntryType, message: string): string {
    const key = logName.toLowerCase();
    if (!this.logs.has(key)) return `Write-EventLog : Cannot open log "${logName}". The log does not exist.`;
    const meta = this.logs.get(key)!;
    meta.entries.push({
      index: nextIndex(),
      timeGenerated: new Date(),
      entryType,
      source,
      eventId,
      category: '(0)',
      message,
    });
    return '';
  }

  clearEventLog(logName: string): string {
    const key = logName.toLowerCase();
    if (!this.logs.has(key)) return `Clear-EventLog : No log with name "${logName}" was found.`;
    this.logs.get(key)!.entries = [];
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

  limitEventLog(logName: string): string {
    // Silently accept — size limits are not enforced in simulation.
    const key = logName.toLowerCase();
    if (!this.logs.has(key)) return `Limit-EventLog : No log with name "${logName}" was found.`;
    return '';
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
