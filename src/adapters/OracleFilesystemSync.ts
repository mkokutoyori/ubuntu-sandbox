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
import { ORACLE_CONFIG } from '@/terminal/commands/OracleConfig';

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
