/**
 * InstanceAdminExecutor — instance / storage administration handlers.
 *
 * Extracted from the OracleExecutor god class (backlog O7). Owns:
 * STARTUP / SHUTDOWN, ALTER SYSTEM, ALTER DATABASE (archivelog mode,
 * MOUNT/OPEN transitions, datafile rename/resize/autoextend), CREATE/
 * DROP/ALTER TABLESPACE, CREATE PFILE/SPFILE, and the ASM diskgroup
 * statements. Storage mutations publish their `oracle.storage.*` /
 * `oracle.asm.*` events here, next to the code that performs them.
 *
 * Device VFS access (CREATE SPFILE FROM PFILE='…') goes through
 * `OracleInstance.readDeviceFile`, whose implementation is injected by
 * the terminal wiring — the database layer no longer imports
 * network/Equipment.
 */

import { type ResultSet, emptyResult } from '../../engine/executor/ResultSet';
import type {
  StartupStatement, ShutdownStatement, AlterSystemStatement,
  AlterDatabaseStatement, CreateTablespaceStatement, DropTablespaceStatement,
  AlterTablespaceStatement, AlterTablespaceAction, CreatePfileSpfileStatement,
  CreateDiskgroupStatement, DropDiskgroupStatement, AlterDiskgroupStatement,
} from '../../engine/parser/ASTNode';
import { OracleError } from '../../engine/types/DatabaseError';
import type { OracleStorage } from '../OracleStorage';
import type { OracleCatalog } from '../OracleCatalog';
import type { OracleInstance } from '../OracleInstance';
import type { PrivilegeEnforcer } from '../security/PrivilegeEnforcer';
import { ORACLE_CONFIG } from '../OracleConfig';

export interface InstanceAdminDeps {
  storage: OracleStorage;
  catalog: OracleCatalog;
  instance: OracleInstance;
  privileges: PrivilegeEnforcer;
}

export class InstanceAdminExecutor {
  constructor(private readonly deps: InstanceAdminDeps) {}

  private get storage(): OracleStorage { return this.deps.storage; }
  private get instance(): OracleInstance { return this.deps.instance; }
  private get bus() { return this.instance.getBus(); }
  private get deviceId() { return this.instance.getDeviceId(); }
  private get sid() { return this.instance.config.sid; }

  // ── Instance lifecycle ────────────────────────────────────────────

  executeStartup(stmt: StartupStatement): ResultSet {
    const output = this.instance.startup(stmt.mode);
    return emptyResult(output.join('\n'));
  }

  executeShutdown(stmt: ShutdownStatement): ResultSet {
    const output = this.instance.shutdown(stmt.mode);
    return emptyResult(output.join('\n'));
  }

  executeAlterSystem(stmt: AlterSystemStatement): ResultSet {
    this.deps.privileges.requireSystemPrivilege('ALTER SYSTEM');
    if (stmt.action === 'SET' && stmt.parameter && stmt.value) {
      this.instance.setParameter(stmt.parameter, stmt.value, stmt.scope as 'MEMORY' | 'SPFILE' | 'BOTH' | undefined);
      return emptyResult('System altered.');
    }
    if (stmt.action === 'SWITCH LOGFILE') {
      return emptyResult(this.instance.switchLogfile());
    }
    if (stmt.action === 'CHECKPOINT') {
      // Real checkpoint: advances the SCN and stamps it into the
      // datafile headers (V$DATAFILE / V$DATAFILE_HEADER read it back).
      this.instance.performCheckpoint();
      return emptyResult('System altered.');
    }
    if (stmt.action === 'FLUSH') {
      return emptyResult('System altered.');
    }
    if (stmt.action === 'KILL SESSION' || stmt.action === 'DISCONNECT SESSION') {
      const sessionId = stmt.sessionId ?? '';
      const parts = sessionId.split(',');
      const sid = parseInt(parts[0] ?? '0', 10);
      const serial = parseInt(parts[1] ?? '0', 10);
      const engine = this.deps.catalog.getSecurityEngine();
      if (engine) {
        const killed = engine.sessions.killSession(sid, serial);
        if (!killed) {
          throw new OracleError(31, `no such session: ${sessionId}`);
        }
      }
      return emptyResult('System altered.');
    }
    if (stmt.action === 'ARCHIVE LOG') {
      return emptyResult('Statement processed.');
    }
    if (stmt.action === 'ENABLE RESTRICTED SESSION' || stmt.action === 'DISABLE RESTRICTED SESSION') {
      this.instance.setRestrictedSession(stmt.action === 'ENABLE RESTRICTED SESSION');
      return emptyResult('System altered.');
    }
    if (stmt.action === 'RESET') {
      return emptyResult('System altered.');
    }
    return emptyResult('System altered.');
  }

  executeAlterDatabase(stmt: AlterDatabaseStatement): ResultSet {
    if (stmt.action === 'ARCHIVELOG') {
      return emptyResult(this.instance.setArchiveLogMode(true));
    }
    if (stmt.action === 'NOARCHIVELOG') {
      return emptyResult(this.instance.setArchiveLogMode(false));
    }
    if (stmt.action === 'OPEN') {
      this.instance.openDatabase();
      return emptyResult('Database altered.');
    }
    if (stmt.action === 'MOUNT') {
      this.instance.mountDatabase();
      return emptyResult('Database altered.');
    }
    // RENAME FILE 'old' [, 'old2'] TO 'new' [, 'new2']
    // MOVE DATAFILE 'old' TO 'new' [KEEP|REUSE]
    const renameMatch = /^\s*(?:RENAME\s+FILE|MOVE\s+DATAFILE)\s+(.+)$/i.exec(stmt.action);
    if (renameMatch) {
      this.applyDatafileRename(renameMatch[1]);
      return emptyResult('Database altered.');
    }
    // DATAFILE '…' RESIZE 200M
    const resizeMatch = /^\s*DATAFILE\s+'([^']+)'\s+.*\bRESIZE\s+(\d+\s*[KMGT]?)/i.exec(stmt.action);
    if (resizeMatch) {
      this.applyDatafileResize(resizeMatch[1], resizeMatch[2].replace(/\s+/g, ''));
      return emptyResult('Database altered.');
    }
    // DATAFILE '…' AUTOEXTEND ON|OFF
    const autoMatch = /^\s*DATAFILE\s+'([^']+)'\s+.*\bAUTOEXTEND\s+(ON|OFF)\b/i.exec(stmt.action);
    if (autoMatch) {
      this.applyDatafileAutoextend(autoMatch[1], autoMatch[2].toUpperCase() === 'ON');
      return emptyResult('Database altered.');
    }
    return emptyResult('Database altered.');
  }

  // ── Datafile maintenance ──────────────────────────────────────────

  private applyDatafileResize(path: string, size: string): void {
    const ts = this.storage.resizeDatafile(path, size);
    if (!ts) return;
    this.bus.publish({
      topic: 'oracle.storage.datafile-resized',
      payload: { deviceId: this.deviceId, sid: this.sid, tablespace: ts, path, size },
    });
  }

  private applyDatafileAutoextend(path: string, on: boolean): void {
    const ts = this.storage.setDatafileAutoextend(path, on);
    if (!ts) return;
    this.bus.publish({
      topic: 'oracle.storage.datafile-autoextend-changed',
      payload: { deviceId: this.deviceId, sid: this.sid, tablespace: ts, path, autoextend: on },
    });
  }

  /**
   * Parse the comma-separated FROM/TO lists in
   *   ALTER DATABASE RENAME FILE 'a','b' TO 'c','d'
   * and apply each rename through the storage layer, emitting one
   * `oracle.storage.datafile-renamed` event per actual rename.
   */
  private applyDatafileRename(tail: string): void {
    const [lhs, rhs] = tail.split(/\bTO\b/i);
    const pick = (s: string | undefined): string[] =>
      (s ?? '').match(/'([^']*)'/g)?.map(q => q.slice(1, -1)) ?? [];
    const olds = pick(lhs);
    const news = pick(rhs);
    if (olds.length === 0) return;
    for (let i = 0; i < olds.length; i++) {
      const oldPath = olds[i];
      const newPath = news[i] ?? olds[i];
      if (!newPath || newPath === oldPath) continue;
      const ts = this.storage.renameDatafile(oldPath, newPath);
      if (!ts) continue;
      this.bus.publish({
        topic: 'oracle.storage.datafile-renamed',
        payload: { deviceId: this.deviceId, sid: this.sid, tablespace: ts, oldPath, newPath },
      });
    }
  }

  // ── Tablespaces ───────────────────────────────────────────────────

  executeCreateTablespace(stmt: CreateTablespaceStatement): ResultSet {
    const type: 'PERMANENT' | 'TEMPORARY' | 'UNDO' = stmt.temporary ? 'TEMPORARY' : stmt.undo ? 'UNDO' : 'PERMANENT';
    const datafiles = [{ path: stmt.datafile, size: stmt.size, autoextend: stmt.autoextend?.on ?? false }];
    this.storage.createTablespace({
      name: stmt.name.toUpperCase(),
      type,
      status: 'ONLINE',
      datafiles,
      blockSize: 8192,
      logging: stmt.logging,
      extentManagement: stmt.extentManagement,
      segmentSpaceManagement: stmt.segmentSpaceManagement,
      allocationType: stmt.allocationType,
      encrypted: stmt.encrypted,
    });
    this.bus.publish({
      topic: 'oracle.storage.tablespace-created',
      payload: {
        deviceId: this.deviceId,
        sid: this.sid,
        name: stmt.name.toUpperCase(),
        type,
        datafiles,
      },
    });
    return emptyResult('Tablespace created.');
  }

  executeDropTablespace(stmt: DropTablespaceStatement): ResultSet {
    const ts = this.storage.getTablespace(stmt.name);
    const datafiles = ts ? ts.datafiles.map(d => d.path) : [];
    const type: 'PERMANENT' | 'TEMPORARY' | 'UNDO' = ts?.type ?? 'PERMANENT';
    this.storage.dropTablespace(stmt.name);
    this.bus.publish({
      topic: 'oracle.storage.tablespace-dropped',
      payload: {
        deviceId: this.deviceId,
        sid: this.sid,
        name: stmt.name.toUpperCase(),
        type,
        datafiles,
        removeDatafiles: stmt.includeDatafiles ?? false,
      },
    });
    return emptyResult('Tablespace dropped.');
  }

  executeAlterTablespace(stmt: AlterTablespaceStatement): ResultSet {
    const ts = this.storage.getTablespace(stmt.name);
    if (!ts) throw new OracleError(959, `tablespace '${stmt.name}' does not exist`);
    this.applyAlterTablespaceAction(ts.name, stmt.action);
    return emptyResult('Tablespace altered.');
  }

  private applyAlterTablespaceAction(name: string, action: AlterTablespaceAction): void {
    const storage = this.storage;
    const ts = storage.getTablespace(name)!;
    const publishStatus = (oldStatus: typeof ts.status, newStatus: typeof ts.status) =>
      this.bus.publish({
        topic: 'oracle.storage.tablespace-status-changed',
        payload: { deviceId: this.deviceId, sid: this.sid, name: ts.name, oldStatus, newStatus },
      });
    switch (action.kind) {
      case 'ADD_DATAFILE': {
        const df = { path: action.path, size: action.size, autoextend: action.autoextend ?? false };
        const updated = storage.addDatafileToTablespace(name, df);
        if (!updated) return;
        this.bus.publish({
          topic: 'oracle.storage.datafile-added',
          payload: {
            deviceId: this.deviceId, sid: this.sid,
            tablespace: ts.name, type: ts.type,
            path: df.path, size: df.size, autoextend: df.autoextend,
          },
        });
        return;
      }
      case 'ONLINE': case 'READ_WRITE': {
        const old = ts.status;
        if (storage.setTablespaceStatus(name, 'ONLINE')) publishStatus(old, 'ONLINE');
        return;
      }
      case 'OFFLINE': {
        const old = ts.status;
        if (storage.setTablespaceStatus(name, 'OFFLINE')) publishStatus(old, 'OFFLINE');
        return;
      }
      case 'READ_ONLY': {
        const old = ts.status;
        if (storage.setTablespaceStatus(name, 'READ ONLY')) publishStatus(old, 'READ ONLY');
        return;
      }
      case 'RENAME_TO': {
        const oldName = ts.name;
        storage.renameTablespace(name, action.newName);
        this.bus.publish({
          topic: 'oracle.storage.tablespace-renamed',
          payload: { deviceId: this.deviceId, sid: this.sid, oldName, newName: action.newName.toUpperCase() },
        });
        return;
      }
      case 'RENAME_DATAFILE': {
        const owner = storage.renameDatafile(action.oldPath, action.newPath);
        if (!owner) return;
        this.bus.publish({
          topic: 'oracle.storage.datafile-renamed',
          payload: { deviceId: this.deviceId, sid: this.sid, tablespace: owner, oldPath: action.oldPath, newPath: action.newPath },
        });
        return;
      }
      case 'LOGGING':         ts.logging = true; return;
      case 'NOLOGGING':       ts.logging = false; return;
      case 'FORCE_LOGGING':   ts.forceLogging = true; return;
      case 'NO_FORCE_LOGGING':ts.forceLogging = false; return;
      case 'FLASHBACK_ON':    ts.flashbackOn = true; return;
      case 'FLASHBACK_OFF':   ts.flashbackOn = false; return;
      // Operational verbs with no persisted metadata.
      case 'BEGIN_BACKUP': case 'END_BACKUP':
      case 'SHRINK_SPACE': case 'COALESCE':
        return;
    }
  }

  // ── Parameter files ───────────────────────────────────────────────

  executeCreatePfileSpfile(stmt: CreatePfileSpfileStatement): ResultSet {
    const sid = this.sid;
    // FROM PFILE='path' / FROM SPFILE[='path'] — load the source file
    // from the device VFS and apply its parameters before we render
    // the output file. FROM MEMORY snapshots the live parameter set.
    if (stmt.source === 'PFILE' || stmt.source === 'SPFILE') {
      const srcDefault = stmt.source === 'PFILE'
        ? `${ORACLE_CONFIG.HOME}/dbs/init${sid}.ora`
        : `${ORACLE_CONFIG.HOME}/dbs/spfile${sid}.ora`;
      const src = stmt.sourcePath ?? srcDefault;
      const content = this.instance.readDeviceFile(src);
      // A null read means the source parameter file is not on disk. Real
      // Oracle does NOT silently fall back to the live parameter set —
      // it fails with ORA-01565. Only skip the check when there is no
      // device filesystem at all (engine-only tests: readDeviceFile is
      // unset and returns null for everything, so requiring the file
      // would break those — the live snapshot is the sensible fallback).
      if (content !== null) {
        for (const [k, v] of parseInitParameters(content)) {
          this.instance.setParameter(k, v, 'BOTH');
        }
      } else if (this.instance.hasDeviceFilesystem()) {
        throw new OracleError(1565,
          `error in identifying file '${src}'\n`
          + 'ORA-27037: unable to obtain file status');
      }
    }
    const params: Record<string, string> = {};
    for (const [k, v] of this.instance.getAllParameters()) params[k] = v;
    const defaultPath =
      stmt.target === 'SPFILE'
        ? `${ORACLE_CONFIG.HOME}/dbs/spfile${sid}.ora`
        : `${ORACLE_CONFIG.HOME}/dbs/init${sid}.ora`;
    const outputPath = stmt.outputPath ?? defaultPath;
    this.bus.publish({
      topic: 'oracle.instance.parameter-file-requested',
      payload: {
        deviceId: this.deviceId, sid,
        target: stmt.target, outputPath, params,
      },
    });
    return emptyResult(`File created.`);
  }

  // ── ASM diskgroups ────────────────────────────────────────────────

  executeCreateDiskgroup(stmt: CreateDiskgroupStatement): ResultSet {
    const asm = this.instance.asm;
    const dg = asm.createDiskgroup(stmt.name, { redundancy: stmt.redundancy });
    this.bus.publish({
      topic: 'oracle.asm.diskgroup-created',
      payload: { deviceId: this.deviceId, sid: this.sid, groupNumber: dg.groupNumber, name: dg.name, redundancy: dg.redundancy },
    });
    for (const d of stmt.disks) {
      const { disk } = asm.addDisk(dg.name, d.path, { name: d.name, sizeMb: d.sizeMb });
      this.bus.publish({
        topic: 'oracle.asm.disk-added',
        payload: { deviceId: this.deviceId, sid: this.sid, diskgroup: dg.name, diskNumber: disk.diskNumber, diskName: disk.name, path: disk.path, sizeMb: disk.sizeMb },
      });
    }
    return emptyResult('Diskgroup created.');
  }

  executeDropDiskgroup(stmt: DropDiskgroupStatement): ResultSet {
    const { diskPaths } = this.instance.asm.dropDiskgroup(stmt.name, stmt.includingContents);
    this.bus.publish({
      topic: 'oracle.asm.diskgroup-dropped',
      payload: { deviceId: this.deviceId, sid: this.sid, name: stmt.name.toUpperCase(), diskPaths },
    });
    return emptyResult('Diskgroup dropped.');
  }

  executeAlterDiskgroup(stmt: AlterDiskgroupStatement): ResultSet {
    const asm = this.instance.asm;
    switch (stmt.action.kind) {
      case 'ADD_DISK':
        for (const d of stmt.action.disks) {
          const { diskgroup, disk } = asm.addDisk(stmt.name, d.path, { name: d.name, sizeMb: d.sizeMb, failgroup: d.failgroup });
          this.bus.publish({
            topic: 'oracle.asm.disk-added',
            payload: { deviceId: this.deviceId, sid: this.sid, diskgroup: diskgroup.name, diskNumber: disk.diskNumber, diskName: disk.name, path: disk.path, sizeMb: disk.sizeMb },
          });
        }
        return emptyResult('Diskgroup altered.');
      case 'DROP_DISK':
        for (const id of stmt.action.identifiers) {
          const { diskgroup, disk } = asm.dropDisk(stmt.name, id);
          this.bus.publish({
            topic: 'oracle.asm.disk-dropped',
            payload: { deviceId: this.deviceId, sid: this.sid, diskgroup: diskgroup.name, diskName: disk.name, path: disk.path },
          });
        }
        return emptyResult('Diskgroup altered.');
      case 'REBALANCE': case 'MOUNT': case 'DISMOUNT':
        return emptyResult('Diskgroup altered.');
    }
  }
}

/**
 * Parse the `*.<name>=value` (spfile) and bare `<name>=value` (pfile)
 * lines from an init.ora-style file into a plain (name, value) map.
 * Comment lines (#) and blank lines are skipped; surrounding single
 * quotes on the value are stripped.
 */
export function parseInitParameters(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:\*\.)?([a-zA-Z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    out.set(m[1].toLowerCase(), value);
  }
  return out;
}
