/**
 * OracleFilesystemSync — Phase 7 adapter that materialises Oracle domain
 * events onto the device's VFS.
 *
 * Replaces the per-call `updateSpfileOnDevice`, `syncAlertLogToDevice`,
 * `syncDatafilesToDevice`, `syncOracleProcessesToDevice` invocations
 * scattered across `SqlPlusSubShell` / `OracleCommands` with a single
 * actor-style adapter subscribed to the bus.
 *
 * Lifecycle:
 *   const sync = new OracleFilesystemSync(bus, deviceResolver);
 *   sync.start();
 *   // … bus events arrive, FS gets updated automatically …
 *   sync.stop();
 *
 * The adapter is **stateless** w.r.t. the engine: it never reads from
 * OracleInstance directly. Everything it materialises is carried by the
 * event payload — except for the parameter set (which it accumulates
 * locally) and the datafile list (which still requires the OracleDatabase
 * to walk its tablespaces, since the Storage view is too granular to be
 * stored in events). For those cases the adapter is given a
 * `deviceResolver` callback so it can locate the device and the Oracle
 * database when needed.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { Equipment } from '@/network/equipment/Equipment';
import type { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { ORACLE_CONFIG } from '@/database/oracle/OracleConfig';

export interface OracleFilesystemSyncCtx {
  /** Resolve a deviceId to the Equipment instance to write files on. */
  resolveDevice(deviceId: string): Equipment | null;
  /** Resolve a deviceId to its OracleDatabase (for datafile / process sync). */
  resolveDatabase(deviceId: string): OracleDatabase | null;
}

/**
 * Equipment shape we touch — keeps the adapter independent of any
 * concrete subclass (LinuxServer, etc.).
 */
interface FsEquipment {
  writeFileFromEditor(path: string, content: string): void;
  deleteFileFromEditor?: (path: string) => boolean;
  registerProcess?: (pid: number, user: string, cmd: string) => void;
  unregisterProcess?: (pid: number) => void;
  clearSystemProcesses?: () => void;
}

export class OracleFilesystemSync {
  private subs: Unsubscribe[] = [];
  /** Per-device accumulated spfile parameters, rendered atomically on each change. */
  private spfileParams: Map<string, Map<string, string>> = new Map();
  /** Per-device monotonically increasing counter used in adump/*.aud filenames. */
  private auditCounters: Map<string, number> = new Map();

  constructor(
    private readonly bus: IEventBus,
    private readonly ctx: OracleFilesystemSyncCtx,
  ) {}

  start(): void {
    if (this.subs.length > 0) return;

    this.subs.push(
      this.bus.subscribe('oracle.instance.parameter-changed', (e) => {
        const { deviceId, sid, key, newValue, scope } = e.payload;
        if (scope === 'MEMORY') return; // memory-only changes don't touch spfile
        const params = this.spfileParams.get(deviceId) ?? new Map<string, string>();
        params.set(key, newValue);
        this.spfileParams.set(deviceId, params);
        this.writeSpfile(deviceId, sid, params);
      }),

      this.bus.subscribe('oracle.instance.alert-log-entry-added', (e) => {
        const { deviceId, sid, line } = e.payload;
        const dev = this.dev(deviceId);
        if (!dev) return;
        const path = `${ORACLE_CONFIG.DIAG_TRACE}/alert_${sid}.log`;
        // Append to the existing log (we re-read from the in-memory accumulator —
        // the adapter doesn't keep history itself).
        const db = this.ctx.resolveDatabase(deviceId);
        if (db) {
          dev.writeFileFromEditor(path, db.instance.getAlertLog().join('\n') + '\n');
        } else {
          // No DB available — best effort, write just this line.
          dev.writeFileFromEditor(path, line + '\n');
        }
      }),

      this.bus.subscribe('oracle.instance.state-changed', (e) => {
        const { deviceId, newState } = e.payload;
        // Datafile materialisation only makes sense once the DB is at least mounted.
        if (newState === 'MOUNT' || newState === 'OPEN') {
          this.syncDatafiles(deviceId);
        }
      }),

      this.bus.subscribe('oracle.instance.background-process-started', (e) => {
        const { deviceId, sid, name, pid } = e.payload;
        const dev = this.dev(deviceId);
        if (!dev?.registerProcess) return;
        dev.registerProcess(pid, 'oracle', `ora_${name.toLowerCase()}_${sid.toLowerCase()}`);
      }),

      this.bus.subscribe('oracle.instance.background-process-stopped', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev?.unregisterProcess) return;
        dev.unregisterProcess(e.payload.pid);
      }),

      this.bus.subscribe('oracle.storage.tablespace-created', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        const typeLabel = e.payload.type === 'TEMPORARY' ? 'TEMPFILE' : 'DATAFILE';
        for (const df of e.payload.datafiles) {
          dev.writeFileFromEditor(
            df.path,
            `[ORACLE ${typeLabel} - ${e.payload.name} tablespace - ${df.size}]`,
          );
        }
      }),

      this.bus.subscribe('oracle.storage.datafile-added', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        const typeLabel = e.payload.type === 'TEMPORARY' ? 'TEMPFILE' : 'DATAFILE';
        dev.writeFileFromEditor(
          e.payload.path,
          `[ORACLE ${typeLabel} - ${e.payload.tablespace} tablespace - ${e.payload.size}]`,
        );
      }),

      this.bus.subscribe('oracle.asm.disk-added', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        dev.writeFileFromEditor(
          e.payload.path,
          `[ASM DISK ${e.payload.diskName} - diskgroup ${e.payload.diskgroup} - ${e.payload.sizeMb}M]`,
        );
      }),

      this.bus.subscribe('oracle.asm.disk-dropped', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev?.deleteFileFromEditor) return;
        dev.deleteFileFromEditor(e.payload.path);
      }),

      this.bus.subscribe('oracle.asm.diskgroup-dropped', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev?.deleteFileFromEditor) return;
        for (const p of e.payload.diskPaths) dev.deleteFileFromEditor(p);
      }),

      this.bus.subscribe('oracle.instance.parameter-file-requested', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        dev.writeFileFromEditor(
          e.payload.outputPath,
          renderParameterFile(e.payload.target, e.payload.params),
        );
      }),

      this.bus.subscribe('oracle.audit.recorded', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        const seq = (this.auditCounters.get(e.payload.deviceId) ?? 0) + 1;
        this.auditCounters.set(e.payload.deviceId, seq);
        const fname = `${e.payload.sid.toLowerCase()}_ora_${e.payload.sessionId}_${seq}.aud`;
        dev.writeFileFromEditor(
          `${ORACLE_CONFIG.AUDIT_DIR}/${fname}`,
          renderAuditEntry(e.payload),
        );
      }),

      this.bus.subscribe('oracle.archive-log.created', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        dev.writeFileFromEditor(
          e.payload.path,
          `[ORACLE ARCHIVED REDO LOG - sequence ${e.payload.sequence}]`,
        );
      }),

      this.bus.subscribe('oracle.storage.tablespace-dropped', (e) => {
        if (!e.payload.removeDatafiles) return;
        const dev = this.dev(e.payload.deviceId);
        if (!dev?.deleteFileFromEditor) return;
        for (const path of e.payload.datafiles) {
          dev.deleteFileFromEditor(path);
        }
      }),

      this.bus.subscribe('oracle.storage.datafile-resized', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        const db = this.ctx.resolveDatabase(e.payload.deviceId);
        const storage = db?.storage as import('@/database/oracle/OracleStorage').OracleStorage | undefined;
        const ts = storage?.getTablespace(e.payload.tablespace);
        const typeLabel = ts?.type === 'TEMPORARY' ? 'TEMPFILE' : 'DATAFILE';
        dev.writeFileFromEditor(
          e.payload.path,
          `[ORACLE ${typeLabel} - ${e.payload.tablespace} tablespace - ${e.payload.size}]`,
        );
      }),

      // Security-audit FS sync — writes only to native Oracle paths:
      //   • adump/ — one .aud file per audited action (Oracle XML audit)
      //   • alert log — anomalies / DV violations are alert-worthy
      // This mirrors what `audit_trail=os` + DV + TSDP do on a real
      // Oracle 19c install. No simulator-specific files are written.
      this.bus.subscribe('oracle.security.connection-traced', (e) => {
        // Each connection trace becomes a real adump/.aud file just
        // like a logon/logoff audited by Oracle's OS auditor.
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        const seq = (this.auditCounters.get(e.payload.deviceId) ?? 0) + 1;
        this.auditCounters.set(e.payload.deviceId, seq);
        const fname = `${e.payload.sid.toLowerCase()}_ora_${e.payload.sessionId}_${seq}.aud`;
        const dbid = this.ctx.resolveDatabase(e.payload.deviceId)?.instance.getDbId() ?? 0;
        dev.writeFileFromEditor(
          `${ORACLE_CONFIG.BASE}/admin/${e.payload.sid}/adump/${fname}`,
          renderConnectionAud(e.payload, dbid),
        );
      }),

      this.bus.subscribe('oracle.security.sod-violation', (e) => {
        // DV violations land in the database alert log on a real 19c.
        const db = this.ctx.resolveDatabase(e.payload.deviceId);
        if (db) {
          db.instance.logAlertEvent(
            `Database Vault audit: policy ${e.payload.policyName} violated by `
            + `${e.payload.username} — privileges ${e.payload.conflictingPrivileges.join('+')}`);
        }
      }),

      this.bus.subscribe('oracle.security.anomaly-detected', (e) => {
        // Anomalies surface as alert-log entries (DBA_ALERT_HISTORY
        // already projects them as native rows from this same source).
        const db = this.ctx.resolveDatabase(e.payload.deviceId);
        if (db) {
          db.instance.logAlertEvent(
            `[${e.payload.severity}] ${e.payload.kind}: ${e.payload.description}`);
        }
      }),

      this.bus.subscribe('oracle.security.dormant-detected', (e) => {
        const db = this.ctx.resolveDatabase(e.payload.deviceId);
        if (db) {
          db.instance.logAlertEvent(
            `Dormant account detected: ${e.payload.username} `
            + `last_login=${e.payload.lastLoginAt ? e.payload.lastLoginAt.toISOString() : 'never'} `
            + `days=${e.payload.daysSinceLastLogin}`);
        }
      }),

      this.bus.subscribe('oracle.storage.datafile-renamed', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        const db = this.ctx.resolveDatabase(e.payload.deviceId);
        const storage = db?.storage as import('@/database/oracle/OracleStorage').OracleStorage | undefined;
        const ts = storage?.getTablespace(e.payload.tablespace);
        const df = ts?.datafiles.find(d => d.path === e.payload.newPath);
        const typeLabel = ts?.type === 'TEMPORARY' ? 'TEMPFILE' : 'DATAFILE';
        const size = df?.size ?? '0M';
        dev.writeFileFromEditor(
          e.payload.newPath,
          `[ORACLE ${typeLabel} - ${e.payload.tablespace} tablespace - ${size}]`,
        );
        dev.deleteFileFromEditor?.(e.payload.oldPath);
      }),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
    this.spfileParams.clear();
    this.auditCounters.clear();
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private dev(deviceId: string): FsEquipment | null {
    const eq = this.ctx.resolveDevice(deviceId) as unknown as FsEquipment | null;
    if (!eq || typeof eq.writeFileFromEditor !== 'function') return null;
    return eq;
  }

  private writeSpfile(deviceId: string, sid: string, params: Map<string, string>): void {
    const dev = this.dev(deviceId);
    if (!dev) return;
    const lines: string[] = [];
    for (const [name, value] of params) {
      const needsQuote = /[a-zA-Z]/.test(value) && !value.startsWith("'");
      lines.push(`*.${name}=${needsQuote ? `'${value}'` : value}`);
    }
    dev.writeFileFromEditor(`${ORACLE_CONFIG.HOME}/dbs/spfile${sid}.ora`, lines.join('\n') + '\n');
  }

  private syncDatafiles(deviceId: string): void {
    const dev = this.dev(deviceId);
    const db = this.ctx.resolveDatabase(deviceId);
    if (!dev || !db) return;

    const storage = db.storage as import('@/database/oracle/OracleStorage').OracleStorage;
    for (const ts of storage.getAllTablespaces()) {
      for (const df of ts.datafiles) {
        const typeLabel = ts.type === 'TEMPORARY' ? 'TEMPFILE' : 'DATAFILE';
        const content = `[ORACLE ${typeLabel} - ${ts.name} tablespace - ${df.size}]`;
        dev.writeFileFromEditor(df.path, content);
      }
    }

    for (const group of db.instance.getRedoLogGroups()) {
      for (const member of group.members) {
        const sizeMB = Math.round(group.sizeBytes / 1048576);
        dev.writeFileFromEditor(member, `[ORACLE REDO LOG - Group ${group.group} - ${sizeMB}M]`);
      }
    }

    const ctlFiles = (db.instance.getParameter('control_files') ?? '')
      .split(',').map(f => f.trim()).filter(f => f);
    ctlFiles.forEach((f, i) => {
      dev.writeFileFromEditor(f, `[ORACLE CONTROL FILE ${i + 1}]`);
    });
  }
}

/**
 * Render a parameter snapshot in either spfile (*.<param>=value) or
 * pfile (<param>=value) format.
 */
function renderParameterFile(target: 'PFILE' | 'SPFILE', params: Record<string, string>): string {
  const prefix = target === 'SPFILE' ? '*.' : '';
  const lines: string[] = [];
  for (const name of Object.keys(params).sort()) {
    const value = params[name];
    const needsQuote = /[^0-9.+-]/.test(value) && !value.startsWith("'");
    lines.push(`${prefix}${name}=${needsQuote ? `'${value}'` : value}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Format a single audit entry the way the OS-level `.aud` files look
 * under audit_file_dest. Kept as a free function to stay small and
 * trivially testable without instantiating the adapter.
 */
/**
 * Render the connection-trace `.aud` file the way `audit_trail=os` does
 * it for a logon. Same header banner as audit entries so an `ls` of
 * `adump/` shows a coherent set of files.
 */
/**
 * Common `.aud` banner written by `audit_trail=os`: file path, release
 * banner, host identity, process identity, then the timestamp. Shared by
 * connection traces and audit entries so the two file families can never
 * drift apart again.
 */
function renderAudHeader(sid: string, sessionId: number | string, userhost: string, timestamp: Date): string[] {
  return [
    `Audit file ${ORACLE_CONFIG.AUDIT_DIR}/${sid.toLowerCase()}_ora_${sessionId}.aud`,
    `Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production`,
    `ORACLE_HOME = ${ORACLE_CONFIG.HOME}`,
    `System name:    Linux`,
    `Node name:      ${userhost}`,
    `Instance name:  ${sid}`,
    `Redo thread mounted by this instance: 1`,
    `Oracle process number: ${sessionId}`,
    `Unix process pid: ${sessionId}, image: oracle@${userhost}`,
    '',
    timestamp.toISOString(),
  ];
}

function renderConnectionAud(
  p: import('@/database/oracle/events').OracleConnectionTracedPayload,
  dbid: number,
): string {
  const lines: string[] = renderAudHeader(p.sid, p.sessionId, p.userhost, p.timestamp);
  lines.push(`ACTION : ${p.outcome === 'LOGOFF' ? 'LOGOFF' : 'LOGON'}`);
  lines.push(`DATABASE USER: ${p.username}`);
  lines.push(`PRIVILEGE: ${p.role === 'SYSDBA' ? 'SYSDBA' : p.role === 'SYSOPER' ? 'SYSOPER' : '--'}`);
  lines.push(`CLIENT USER: ${p.osUser}`);
  lines.push(`CLIENT TERMINAL: ${p.terminal}`);
  lines.push(`STATUS: ${p.returncode}`);
  lines.push(`DBID: ${dbid}`);
  lines.push(`SESSIONID: ${p.sessionId}`);
  lines.push(`USERHOST: ${p.userhost}`);
  lines.push(`CLIENT ADDRESS: (ADDRESS=(PROTOCOL=${p.networkProtocol})(HOST=${p.ipAddress || p.userhost}))`);
  lines.push(`AUTHENTICATION_TYPE: ${p.authenticationType}`);
  return lines.join('\n') + '\n';
}

function renderAuditEntry(p: import('@/database/oracle/events').OracleAuditRecordedPayload): string {
  const lines: string[] = renderAudHeader(p.sid, p.sessionId, p.userhost, p.timestamp);
  lines.push(`LENGTH : '${(p.sqlText ?? '').length}'`);
  lines.push(`ACTION : ${p.actionName}`);
  lines.push(`DATABASE USER: ${p.username}`);
  lines.push(`PRIVILEGE: ${p.username === 'SYS' ? 'SYSDBA' : '--'}`);
  lines.push(`CLIENT USER: ${p.osUsername}`);
  lines.push(`CLIENT TERMINAL: ${p.terminal}`);
  lines.push(`STATUS: ${p.returncode}`);
  if (p.objOwner || p.objName) {
    lines.push(`OBJECT: ${p.objOwner ?? ''}.${p.objName ?? ''}`);
  }
  if (p.sqlText) {
    lines.push(`STATEMENT TEXT:`);
    lines.push(p.sqlText);
  }
  return lines.join('\n') + '\n';
}
