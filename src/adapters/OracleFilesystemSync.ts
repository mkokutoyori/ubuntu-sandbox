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
import { parseSize } from '@/database/oracle/views/_fileSize';

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
  installSystemFile?: (path: string, content: string, uid?: number, gid?: number) => boolean;
  deleteFileFromEditor?: (path: string) => boolean;
  registerProcess?: (pid: number, user: string, cmd: string) => void;
  unregisterProcess?: (pid: number) => void;
  clearSystemProcesses?: () => void;
  externalPidForOsPid?: (osPid: number) => number | undefined;
}

const TERMINATING_SIGNALS: ReadonlySet<string> = new Set([
  'SIGTERM', 'SIGKILL', 'SIGINT', 'SIGQUIT', 'SIGHUP',
]);

const ORACLE_OS_UID = 54321;
const ORACLE_OS_GID = 54321;

function scrambledHex(seed: string, bytes = 256): string {
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193 >>> 0;
    h2 = (h2 + c * 0x9e3779b1) >>> 0;
  }
  const out: string[] = [];
  for (let i = 0; i < bytes; i++) {
    h1 = (h1 * 1103515245 + 12345) >>> 0;
    h2 = (h2 * 1664525 + 1013904223) >>> 0;
    out.push(((h1 ^ h2) & 0xff).toString(16).padStart(2, '0'));
  }
  return out.join('');
}

function datafileContent(
  ts: { name: string; type: string; encrypted: boolean },
  df: { path: string; size: string },
): string {
  if (ts.encrypted) return scrambledHex(`${ts.name}:${df.path}`);
  const typeLabel = ts.type === 'TEMPORARY' ? 'TEMPFILE' : 'DATAFILE';
  return `[ORACLE ${typeLabel} - ${ts.name} tablespace - ${df.size}]`;
}

function writeAsOracle(dev: FsEquipment, path: string, content: string): void {
  if (!dev.installSystemFile) {
    dev.writeFileFromEditor(path, content);
    return;
  }
  if (path.startsWith('/u01')) dev.installSystemFile(path, content, ORACLE_OS_UID, ORACLE_OS_GID);
  else dev.installSystemFile(path, content);
}

export class OracleFilesystemSync {
  private subs: Unsubscribe[] = [];
  /** Per-device accumulated spfile parameters, rendered atomically on each change. */
  private spfileParams: Map<string, Map<string, string>> = new Map();
  /** Per-device monotonically increasing counter used in adump/*.aud filenames. */
  private auditCounters: Map<string, number> = new Map();
  /** Datafile paths already materialised per device — see syncDatafiles. */
  private materializedDatafiles: Map<string, Set<string>> = new Map();
  /** SGA KiB currently reserved in each device's host memory (0 = none). */
  private reservedSgaKib: Map<string, number> = new Map();

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
          writeAsOracle(dev, path, db.instance.getAlertLog().join('\n') + '\n');
        } else {
          // No DB available — best effort, write just this line.
          writeAsOracle(dev, path, line + '\n');
        }
      }),

      this.bus.subscribe('oracle.listener.connection-logged', (e) => {
        const { deviceId, sid } = e.payload;
        const dev = this.dev(deviceId);
        if (!dev) return;
        const path = `${ORACLE_CONFIG.BASE}/diag/tnslsnr/${sid.toLowerCase()}/listener/trace/listener.log`;
        const db = this.ctx.resolveDatabase(deviceId);
        if (db) {
          writeAsOracle(dev, path, db.instance.getListenerLog()
            .map(entry => `${entry.timestamp} * (CONNECT_DATA=(SERVICE_NAME=${entry.service})) * `
              + `(ADDRESS=(PROTOCOL=tcp)(HOST=${entry.sourceIp})) * ${entry.result} * ${entry.returnCode}`)
            .join('\n') + '\n');
        } else {
          writeAsOracle(dev, path, e.payload.line + '\n');
        }
      }),

      this.bus.subscribe('oracle.instance.state-changed', (e) => {
        const { deviceId, newState } = e.payload;
        // Datafile materialisation only makes sense once the DB is at least mounted.
        if (newState === 'MOUNT' || newState === 'OPEN') {
          this.syncDatafiles(deviceId);
        }
        this.syncSgaMemory(deviceId, newState === 'OPEN');
      }),

      this.bus.subscribe('oracle.storage.tablespace-encrypted', (e) => {
        this.reencryptTablespaceDatafiles(e.payload.deviceId, e.payload.name);
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

      // Dedicated server processes: one oracleSID (LOCAL=…) per user
      // session, so `ps` agrees with V$PROCESS/V$SESSION while the
      // session lives.
      this.bus.subscribe('oracle.instance.server-process-started', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev?.registerProcess) return;
        dev.registerProcess(e.payload.pid, 'oracle', e.payload.command);
      }),

      this.bus.subscribe('oracle.instance.server-process-stopped', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev?.unregisterProcess) return;
        dev.unregisterProcess(e.payload.pid);
      }),

      this.bus.subscribe('linux.process.signalled', (e) => {
        const { deviceId, pid, signal, delivered } = e.payload;
        if (!delivered || !TERMINATING_SIGNALS.has(signal)) return;
        const dev = this.dev(deviceId);
        const externalPid = dev?.externalPidForOsPid?.(pid);
        if (externalPid === undefined) return;
        const db = this.ctx.resolveDatabase(deviceId);
        if (!db) return;
        // A dedicated server process death ends just that one session.
        const sp = db.instance.getServerProcessByPid(externalPid);
        if (sp) {
          db.endSessionByOsKill(sp.sessionSid);
          return;
        }
        // A background process death is either fatal (instance crash) or
        // transparently restarted by PMON — the instance decides.
        db.instance.handleBackgroundProcessDeath(externalPid);
      }),

      this.bus.subscribe('oracle.storage.tablespace-created', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        const ts = this.ctx.resolveDatabase(e.payload.deviceId)?.storage.getTablespace(e.payload.name);
        for (const df of e.payload.datafiles) {
          this.markDatafileMaterialized(e.payload.deviceId, df.path);
          writeAsOracle(dev, df.path, ts ? datafileContent(ts, df) : `[ORACLE ${e.payload.type === 'TEMPORARY' ? 'TEMPFILE' : 'DATAFILE'} - ${e.payload.name} tablespace - ${df.size}]`);
        }
      }),

      this.bus.subscribe('oracle.storage.datafile-added', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        const ts = this.ctx.resolveDatabase(e.payload.deviceId)?.storage.getTablespace(e.payload.tablespace);
        this.markDatafileMaterialized(e.payload.deviceId, e.payload.path);
        const df = { path: e.payload.path, size: e.payload.size };
        writeAsOracle(dev, e.payload.path, ts ? datafileContent(ts, df) : `[ORACLE ${e.payload.type === 'TEMPORARY' ? 'TEMPFILE' : 'DATAFILE'} - ${e.payload.tablespace} tablespace - ${e.payload.size}]`);
      }),

      this.bus.subscribe('oracle.asm.disk-added', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        writeAsOracle(dev, 
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
        writeAsOracle(dev, 
          e.payload.outputPath,
          renderParameterFile(e.payload.target, e.payload.params),
        );
      }),

      this.bus.subscribe('oracle.audit.recorded', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        // Honour audit_trail. Under DB / DB,EXTENDED the record lives in
        // the database trail (DBA_AUDIT_TRAIL) only — writing an .aud
        // file too was a lie. The exception is SYS operations
        // (audit_sys_operations is TRUE by default in 19c): a session
        // connected AS SYSDBA is always audited to the OS trail
        // regardless of audit_trail.
        const isSysOperation = (e.payload.username ?? '').toUpperCase() === 'SYS';
        if (!isSysOperation && !this.auditsToOs(e.payload.deviceId)) return;
        const seq = (this.auditCounters.get(e.payload.deviceId) ?? 0) + 1;
        this.auditCounters.set(e.payload.deviceId, seq);
        const fname = `${e.payload.sid.toLowerCase()}_ora_${e.payload.sessionId}_${seq}.aud`;
        writeAsOracle(dev,
          `${ORACLE_CONFIG.AUDIT_DIR}/${fname}`,
          renderAuditEntry(e.payload),
        );
      }),

      this.bus.subscribe('oracle.archive-log.created', (e) => {
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        writeAsOracle(dev, 
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
        writeAsOracle(dev, 
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
        // like a logon/logoff audited by Oracle's OS auditor — but only
        // when real Oracle would write one. Mandatory auditing always
        // writes to the OS trail: privileged (SYSDBA/SYSOPER) logons and
        // every FAILED logon attempt. A successful NORMAL logon/logoff
        // goes to DBA_AUDIT_SESSION (the DB trail) unless audit_trail is
        // OS / XML.
        const privileged = e.payload.role === 'SYSDBA' || e.payload.role === 'SYSOPER';
        const failedLogon = e.payload.outcome === 'FAILURE';
        if (!privileged && !failedLogon && !this.auditsToOs(e.payload.deviceId)) return;
        const dev = this.dev(e.payload.deviceId);
        if (!dev) return;
        const seq = (this.auditCounters.get(e.payload.deviceId) ?? 0) + 1;
        this.auditCounters.set(e.payload.deviceId, seq);
        const fname = `${e.payload.sid.toLowerCase()}_ora_${e.payload.sessionId}_${seq}.aud`;
        const dbid = this.ctx.resolveDatabase(e.payload.deviceId)?.instance.getDbId() ?? 0;
        writeAsOracle(dev, 
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
        writeAsOracle(dev, 
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
    this.reservedSgaKib.clear();
  }

  /** Reserve the SGA for an already-open instance — the boot startup
   *  fired its state-changed before the database was registered. */
  primeSgaMemory(deviceId: string): void {
    if (this.ctx.resolveDatabase(deviceId)?.instance.state === 'OPEN') {
      this.syncSgaMemory(deviceId, true);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private syncSgaMemory(deviceId: string, open: boolean): void {
    const memory = (this.ctx.resolveDevice(deviceId) as unknown as
      { getHardware?: () => { memory?: { reserveShared(k: number): void; releaseShared(k: number): void } } } | null)
      ?.getHardware?.().memory;
    if (!memory) return;
    const db = this.ctx.resolveDatabase(deviceId);
    const current = this.reservedSgaKib.get(deviceId) ?? 0;
    if (open && db && current === 0) {
      const kib = Math.round(parseSize(db.instance.getSGAInfo().totalSize) / 1024);
      if (kib > 0) {
        memory.reserveShared(kib);
        this.reservedSgaKib.set(deviceId, kib);
      }
    } else if (!open && current > 0) {
      memory.releaseShared(current);
      this.reservedSgaKib.set(deviceId, 0);
    }
  }

  private dev(deviceId: string): FsEquipment | null {
    const eq = this.ctx.resolveDevice(deviceId) as unknown as FsEquipment | null;
    if (!eq || typeof eq.writeFileFromEditor !== 'function') return null;
    return eq;
  }

  /**
   * Whether the live `audit_trail` parameter directs (non-mandatory)
   * audit records to OS files. DB / DB,EXTENDED / NONE keep them in the
   * database trail; OS and XML write `.aud` / `.xml` under adump/.
   */
  private auditsToOs(deviceId: string): boolean {
    const mode = (this.ctx.resolveDatabase(deviceId)?.instance.getParameter('audit_trail') ?? 'DB')
      .toUpperCase();
    return mode === 'OS' || mode === 'XML';
  }

  private writeSpfile(deviceId: string, sid: string, params: Map<string, string>): void {
    const dev = this.dev(deviceId);
    if (!dev) return;
    const lines: string[] = [];
    for (const [name, value] of params) {
      const needsQuote = /[a-zA-Z]/.test(value) && !value.startsWith("'");
      lines.push(`*.${name}=${needsQuote ? `'${value}'` : value}`);
    }
    writeAsOracle(dev, `${ORACLE_CONFIG.HOME}/dbs/spfile${sid}.ora`, lines.join('\n') + '\n');
  }

  /** Remember that a datafile path has been written once on a device. */
  private markDatafileMaterialized(deviceId: string, path: string): void {
    const seen = this.materializedDatafiles.get(deviceId) ?? new Set<string>();
    seen.add(path);
    this.materializedDatafiles.set(deviceId, seen);
  }

  /**
   * Mark every database file the instance currently knows (datafiles,
   * redo log members, control files) as already materialised. Called
   * once by the boot wiring, whose provisioning (initOracleFilesystem)
   * wrote the seed files before the database was registered — without
   * this, the first post-boot MOUNT would treat them as never-written
   * and resurrect any file the user deleted in between.
   */
  primeDatafiles(deviceId: string): void {
    const db = this.ctx.resolveDatabase(deviceId);
    if (!db) return;
    const storage = db.storage as import('@/database/oracle/OracleStorage').OracleStorage;
    for (const ts of storage.getAllTablespaces()) {
      for (const df of ts.datafiles) this.markDatafileMaterialized(deviceId, df.path);
    }
    for (const group of db.instance.getRedoLogGroups()) {
      for (const member of group.members) this.markDatafileMaterialized(deviceId, member);
    }
    for (const ctl of db.instance.getControlFilePaths()) {
      this.markDatafileMaterialized(deviceId, ctl);
    }
  }

  private syncDatafiles(deviceId: string): void {
    const dev = this.dev(deviceId);
    const db = this.ctx.resolveDatabase(deviceId);
    if (!dev || !db) return;

    const storage = db.storage as import('@/database/oracle/OracleStorage').OracleStorage;
    const seen = this.materializedDatafiles.get(deviceId) ?? new Set<string>();
    this.materializedDatafiles.set(deviceId, seen);
    for (const ts of storage.getAllTablespaces()) {
      for (const df of ts.datafiles) {
        // Materialise each datafile ONCE. After that the VFS is the
        // authority on existence: an `rm` from bash must not be undone
        // by the next state-change sync — the hole it leaves is what
        // the instance's ORA-01157 open check (and RMAN RESTORE, which
        // rewrites the file) are about.
        if (seen.has(df.path)) continue;
        seen.add(df.path);
        writeAsOracle(dev, df.path, datafileContent(ts, df));
      }
    }

    // Redo log members and control files follow the same once-only
    // doctrine as datafiles: after the first materialisation the VFS is
    // the authority on existence. Re-writing them on every state change
    // used to resurrect an `rm control01.ctl` — making the MOUNT-time
    // ORA-00205 check impossible to ever trip.
    for (const group of db.instance.getRedoLogGroups()) {
      for (const member of group.members) {
        if (seen.has(member)) continue;
        seen.add(member);
        const sizeMB = Math.round(group.sizeBytes / 1048576);
        writeAsOracle(dev, member, `[ORACLE REDO LOG - Group ${group.group} - ${sizeMB}M]`);
      }
    }

    db.instance.getControlFilePaths().forEach((f, i) => {
      if (seen.has(f)) return;
      seen.add(f);
      writeAsOracle(dev, f, `[ORACLE CONTROL FILE ${i + 1}]`);
    });
  }

  private reencryptTablespaceDatafiles(deviceId: string, tablespaceName: string): void {
    const dev = this.dev(deviceId);
    const db = this.ctx.resolveDatabase(deviceId);
    if (!dev || !db) return;
    const storage = db.storage as import('@/database/oracle/OracleStorage').OracleStorage;
    const ts = storage.getTablespace(tablespaceName);
    if (!ts) return;
    for (const df of ts.datafiles) {
      writeAsOracle(dev, df.path, datafileContent(ts, df));
    }
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
