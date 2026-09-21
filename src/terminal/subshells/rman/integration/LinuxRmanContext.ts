/**
 * LinuxRmanContext — adapts an Equipment (LinuxServer / LinuxPC) to
 * IRmanOracleContext for the RMAN session.
 *
 * VFS writes go through the device's `writeFileFromEditor` which is the
 * stable cross-device file-write surface.
 *
 * When the device has a registered OracleDatabase (booted via sqlplus or
 * the database commands), every accessor delegates to the live instance
 * so dbName, datafile paths, and instance state stay in sync with the
 * rest of the simulator. Without one, the context falls back to the
 * canonical ORCL/OPEN defaults so RMAN remains usable on a plain device.
 */

import { DbId } from '../values/DbId';
import { ok, err, type Result } from '../core/Result';
import type {
  IRmanOracleContext, DatafileInfo, VfsAdapter, ConnectTargetOutcome, RecordedBackupPiece,
  SqlStatementOutcome, RmanCredentials, ArchivedLogRecord,
} from './IRmanOracleContext';
import type { HostCapableDevice } from '@/network';
import { resolveOracleConnectTarget } from '@/terminal/commands/oracleNet';
import type { ConnectPeerOutcome } from './IRmanOracleContext';
import type { Equipment } from '@/network';
import type { RmanError } from '../core/RmanError';
import type { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { getRegisteredOracleDatabase } from '@/terminal/commands/database';
import { ORACLE_CONFIG } from '@/database/oracle/OracleConfig';
import { archivedLogFromPath } from '../core/archivedLogNaming';
import { recoveryAreaUsage } from '@/database/oracle/storage/RecoveryArea';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { OracleNetSession } from '@/network/oracle-net/OracleNetClient';
import {
  logonOverOracleNet, executeOverOracleNet,
} from '@/network/oracle-net/OracleNetSqlClient';
import { OracleNetCallStatus } from '@/network/oracle-net/wire/OracleNetCall';

interface FsCapableEquipment {
  executeShellCommandSync?(command: string): string;
  writeFileFromEditor(path: string, content: string, declaredSizeBytes?: number): boolean;
  writeFileAsOracle?(path: string, content: string, declaredSizeBytes?: number): boolean;
  freeDiskBytes?(): number;
  readFileForEditor?(path: string): string | null;
  readFile?(path: string): string | null;
  deleteFileFromEditor?(path: string): boolean;
  deleteFile?(path: string): boolean;
  makeDirectoryAsOracle?(path: string): boolean;
}

const ORADATA_BASE = `${ORACLE_CONFIG.BASE}/oradata`;

export class LinuxRmanContext implements IRmanOracleContext {
  readonly dbId: DbId;
  readonly dbName: string;
  readonly vfs: VfsAdapter;
  private _sysdbaExecutor: import('@/database/oracle/OracleExecutor').OracleExecutor | null = null;

  private constructor(
    private readonly _device: Equipment,
    private readonly _oracle: OracleDatabase | null,
    private readonly _netSession: OracleNetSession | null = null,
  ) {
    const sid = _oracle?.instance.config.sid ?? 'ORCL';
    // Live instances expose their real DBID (same value V$DATABASE
    // shows); the canonical DEFAULT only covers Oracle-less devices.
    this.dbId   = _oracle ? DbId.of(_oracle.instance.getDbId(), sid) : DbId.DEFAULT;
    this.dbName = sid;
    this.vfs    = this._buildVfsAdapter();
  }

  connectTarget(identifier: string, credentials?: RmanCredentials): ConnectTargetOutcome {
    const local = this._device as unknown as HostCapableDevice;
    const resolved = resolveOracleConnectTarget(
      local, identifier, (id) => getRegisteredOracleDatabase(id) as OracleDatabase);
    if (resolved.ok === false) return { ok: false, error: resolved.error };
    return {
      ok: true,
      dbName: resolved.db.instance.config.sid,
      dbId: resolved.db.instance.getDbId(),
      remote: resolved.remote,
    };
  }

  connectPeer(identifier: string, credentials?: RmanCredentials): ConnectPeerOutcome {
    const resolved = LinuxRmanContext.forTarget(this._device, identifier, credentials);
    if (resolved.ok === false) return { ok: false, error: resolved.error };
    const peer = resolved.ctx;
    return {
      ok: true,
      dbName: peer.dbName,
      dbId: peer.dbId.value,
      remote: resolved.remote,
      runSql: (statement: string) => peer.runSqlStatement(statement),
      context: peer,
    };
  }

  static forTarget(
    localDevice: Equipment,
    identifier: string,
    credentials?: RmanCredentials,
  ): { ok: true; ctx: LinuxRmanContext; deviceId: string; remote: boolean }
     | { ok: false; error: string } {
    const resolved = resolveOracleConnectTarget(
      localDevice as unknown as HostCapableDevice, identifier,
      (id) => getRegisteredOracleDatabase(id) as OracleDatabase);
    if (resolved.ok === false) return { ok: false, error: resolved.error };
    const deviceId = resolved.db.instance.getDeviceId();
    const targetDevice = EquipmentRegistry.getInstance().getById(deviceId) ?? localDevice;
    const session = resolved.session ?? null;
    if (session) {
      const refus = LinuxRmanContext.logonOn(session, localDevice, credentials);
      if (refus !== null) {
        session.close();
        return { ok: false, error: refus };
      }
    }
    return {
      ok: true,
      ctx: new LinuxRmanContext(targetDevice, resolved.db, session),
      deviceId,
      remote: resolved.remote,
    };
  }

  /**
   * Le processus serveur de la cible ouvre la session pour RMAN comme il
   * l'ouvre pour sqlplus : par un appel Logon sur le MEME fil que les
   * requetes qui suivront. Sans lui, la premiere requete arriverait sur
   * une session que le serveur n'a jamais authentifiee.
   */
  private static logonOn(
    session: OracleNetSession, localDevice: Equipment, credentials?: RmanCredentials,
  ): string | null {
    const hote = localDevice as unknown as { getHostname?: () => string };
    const answer = logonOverOracleNet(session, {
      username: credentials?.username || 'SYS',
      password: credentials?.password ?? '',
      asSysdba: credentials?.asSysdba ?? true,
      identity: {
        osUser: 'oracle',
        osGroup: 'dba',
        hostname: hote.getHostname?.() ?? 'unknown',
        terminal: 'pts/0',
        program: 'rman',
      },
    });
    return answer.status === OracleNetCallStatus.Error ? answer.error : null;
  }

  static forDevice(device: Equipment): LinuxRmanContext {
    const oracle = (() => {
      try { return getRegisteredOracleDatabase((device as { id?: string }).id ?? '') ?? null; }
      catch { return null; }
    })();
    return new LinuxRmanContext(device, oracle);
  }

  /** Test-only: build a context with an explicit Oracle (skips the registry lookup). */
  static withOracle(device: Equipment, oracle: OracleDatabase | null): LinuxRmanContext {
    return new LinuxRmanContext(device, oracle);
  }

  getDatafiles(): ReadonlyArray<DatafileInfo> {
    // Cible DISTANTE : la liste se DEMANDE, elle ne se lit pas sur
    // l'objet du pair. C'est la meme vue, interrogee par le fil.
    const parLeFil = this._netSession ? this.datafilesOverOracleNet() : null;
    if (parLeFil) return parLeFil;
    // Live database: the canonical V$DATAFILE enumeration — a
    // tablespace created after boot is backed up / restored like any
    // other, and file numbers agree with the dictionary views.
    if (this._oracle) {
      return this._oracle.storage.listDatafiles();
    }
    // Oracle-less device: the canonical seeded layout.
    const base = `${ORADATA_BASE}/${this.dbName}`;
    return [
      { fileNo: 1, path: `${base}/system01.dbf`,  sizeBytes: 838_860_800, tablespace: 'SYSTEM'   },
      { fileNo: 2, path: `${base}/sysaux01.dbf`,  sizeBytes: 576_716_800, tablespace: 'SYSAUX'   },
      { fileNo: 3, path: `${base}/undotbs01.dbf`, sizeBytes: 209_715_200, tablespace: 'UNDOTBS1' },
      { fileNo: 4, path: `${base}/users01.dbf`,   sizeBytes: 104_857_600, tablespace: 'USERS'    },
    ];
  }

  getCurrentScn(): number {
    const distant = this.askRemoteScalar('SELECT current_scn FROM V$DATABASE', 'CURRENT_SCN');
    if (distant !== null) return Number(distant);
    return this._oracle?.instance.getCurrentScn() ?? 0;
  }

  checkpointDatafiles(): void {
    this._oracle?.instance.performCheckpoint();
  }

  runSqlStatement(statement: string): SqlStatementOutcome {
    if (this._netSession) return this.runSqlOverOracleNet(statement);
    const oracle = this._oracle;
    if (!oracle) return { ok: false, error: 'ORA-01034: ORACLE not available' };
    try {
      const executor = this._sysdbaExecutor
        ?? (this._sysdbaExecutor = oracle.connectAsSysdba().executor);
      const result = oracle.executeSql(executor, statement.replace(/;$/, ''));
      const lines: string[] = [];
      if (result.message) lines.push(...result.message.split('\n'));
      for (const row of result.rows ?? []) lines.push(row.map(String).join(' '));
      return { ok: true, lines: lines.map(l => l.trim()).filter(Boolean) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Une cible DISTANTE repond par le fil, jamais par son objet.
   * `resolveOracleConnectTarget` a deja ouvert la session Oracle Net que
   * `sqlplus` utilise ; RMAN la jetait et interrogeait la base du pair
   * en memoire, si bien qu'aucune trame ne portait ses commandes.
   */
  private runSqlOverOracleNet(statement: string): SqlStatementOutcome {
    const answer = executeOverOracleNet(this._netSession, statement.replace(/;$/, ''));
    if (answer.status === OracleNetCallStatus.Error) {
      return { ok: false, error: answer.error };
    }
    const result = answer.result;
    if (!result) {
      return { ok: false, error: 'ORA-03113: end-of-file on communication channel' };
    }
    const lines: string[] = [];
    if (result.message) lines.push(...result.message.split('\n'));
    for (const row of result.rows ?? []) lines.push(row.map(String).join(' '));
    return { ok: true, lines: lines.map((l) => l.trim()).filter(Boolean) };
  }

  /**
   * Une cible DISTANTE repond par le fil, jamais par son objet. Ce port
   * est le SEUL endroit ou une question part vers elle ; les accesseurs
   * qui suivent le posent tous, avec leur vue.
   */
  private askRemote(sql: string): {
    columns: ReadonlyArray<{ name: string }>;
    rows: ReadonlyArray<ReadonlyArray<unknown>>;
  } | null {
    if (!this._netSession) return null;
    const answer = executeOverOracleNet(this._netSession, sql);
    if (answer.status === OracleNetCallStatus.Error || !answer.result) return null;
    return { columns: answer.result.columns, rows: answer.result.rows };
  }

  /** La premiere valeur d'une colonne nommee, ou null si la vue ne repond pas. */
  private askRemoteScalar(sql: string, colonne: string): unknown {
    const result = this.askRemote(sql);
    if (!result || result.rows.length === 0) return null;
    const index = result.columns.findIndex((c) => c.name.toUpperCase() === colonne);
    return index < 0 ? null : result.rows[0][index];
  }

  /** Toutes les valeurs d'une colonne nommee, ou null si la vue ne repond pas. */
  private askRemoteColumn(sql: string, colonne: string): string[] | null {
    const result = this.askRemote(sql);
    if (!result) return null;
    const index = result.columns.findIndex((c) => c.name.toUpperCase() === colonne);
    if (index < 0) return null;
    return result.rows.map((row) => String(row[index]));
  }

  private datafilesOverOracleNet(): DatafileInfo[] | null {
    const result = this.askRemote('SELECT * FROM V$DATAFILE');
    if (!result) return null;
    const { columns, rows } = result;
    const colonne = (nom: string): number =>
      columns.findIndex((c) => c.name.toUpperCase() === nom);
    const iFile = colonne('FILE#');
    const iNom = colonne('NAME');
    const iOctets = colonne('BYTES');
    const iTs = colonne('TS#_NAME');
    if (iFile < 0 || iNom < 0 || iOctets < 0 || iTs < 0) return null;
    return rows.map((row) => ({
      fileNo: Number(row[iFile]),
      path: String(row[iNom]),
      sizeBytes: Number(row[iOctets]),
      tablespace: String(row[iTs]),
    }));
  }

  recordBlockCorruption(fileNo: number, blocks: number, type: 'CHECKSUM' | 'CORRUPT'): void {
    const oracle = this._oracle;
    if (!oracle) return;
    oracle.instance.getBus().publish({
      topic: 'oracle.block-corruption.found',
      payload: {
        deviceId: (this._device as { id?: string }).id ?? '',
        sid: oracle.instance.config.sid,
        fileNo, blocks, type,
      },
    });
  }

  recordBackupPiece(piece: RecordedBackupPiece): void {
    const oracle = this._oracle;
    if (!oracle) return;
    oracle.instance.getBus().publish({
      topic: 'oracle.backup.recorded',
      payload: {
        deviceId:    (this._device as { id?: string }).id ?? '',
        sid:         oracle.instance.config.sid,
        setId:       piece.setId,
        pieceId:     piece.pieceId,
        type:        piece.type,
        handle:      piece.handle,
        bytes:       piece.bytes,
        startedAt:   piece.startedAt,
        completedAt: piece.completedAt,
        status:      'COMPLETED',
      },
    });
  }

  getRecoveryAreaUsedBytes(): number {
    const distant = this.askRemoteScalar(
      'SELECT space_used FROM V$RECOVERY_FILE_DEST', 'SPACE_USED');
    if (distant !== null) return Number(distant);
    const oracle = this._oracle;
    if (!oracle) return 0;
    return recoveryAreaUsage(
      oracle.instance.getParameter('db_recovery_file_dest') ?? ORACLE_CONFIG.FRA,
      oracle.instance.getParameter('db_recovery_file_dest_size'),
      oracle.instance.getRuntimeState()).usedBytes;
  }

  getSpfileParam(name: string): string | undefined {
    const key = name.toLowerCase();
    const distant = this.askRemoteScalar(
      `SELECT value FROM V$PARAMETER WHERE name = '${key}'`, 'VALUE');
    if (distant !== null && String(distant) !== '') return String(distant);
    const live = this._oracle?.instance.getParameter(key);
    if (live !== undefined && live !== '') return live;
    const sid = this.dbName;
    const map: Record<string, string> = {
      db_name:               sid,
      db_unique_name:        sid,
      instance_name:         sid,
      service_names:         this._oracle?.instance.config.serviceName ?? sid,
      db_recovery_file_dest: ORACLE_CONFIG.FRA,
      control_files:         `${ORADATA_BASE}/${sid}/control01.ctl`,
    };
    return map[key];
  }

  /** Live instance state — falls back to OPEN when no Oracle is registered. */
  getInstanceState(): 'SHUTDOWN' | 'NOMOUNT' | 'MOUNT' | 'OPEN' {
    const distant = this.askRemoteScalar('SELECT status FROM V$INSTANCE', 'STATUS');
    const lu = distant === null ? null : String(distant).toUpperCase();
    if (lu === 'OPEN' || lu === 'MOUNTED' || lu === 'STARTED' || lu === 'SHUTDOWN') {
      // V$INSTANCE nomme MOUNTED et STARTED ce que RMAN appelle MOUNT et
      // NOMOUNT : c'est la vue qui fait foi, pas le vocabulaire interne.
      return lu === 'MOUNTED' ? 'MOUNT' : lu === 'STARTED' ? 'NOMOUNT' : lu;
    }
    return this._oracle?.instance.state ?? 'OPEN';
  }

  getControlFilePaths(): ReadonlyArray<string> {
    const distant = this.askRemoteColumn('SELECT name FROM V$CONTROLFILE', 'NAME');
    if (distant && distant.length > 0) return distant;
    const declared = this._oracle?.instance.getControlFilePaths() ?? [];
    return declared.length > 0 ? declared : [this.getControlFilePath()];
  }

  getControlFilePath(): string {
    return `${ORADATA_BASE}/${this.dbName}/control01.ctl`;
  }

  getArchivelogPaths(): ReadonlyArray<string> {
    return this.getArchivedLogs().map(l => l.path);
  }

  getArchivedLogs(): ReadonlyArray<ArchivedLogRecord> {
    const distant = this.askRemote(
      'SELECT thread#, sequence#, name, first_change#, next_change# FROM V$ARCHIVED_LOG');
    if (distant !== null) {
      const colonne = (nom: string): number =>
        distant.columns.findIndex((c) => c.name.toUpperCase() === nom);
      const iThread = colonne('THREAD#');
      const iSeq = colonne('SEQUENCE#');
      const iNom = colonne('NAME');
      const iFirst = colonne('FIRST_CHANGE#');
      const iNext = colonne('NEXT_CHANGE#');
      if (iSeq >= 0 && iNom >= 0) {
        return distant.rows.map((row) => ({
          thread: iThread < 0 ? 1 : Number(row[iThread]),
          sequence: Number(row[iSeq]),
          path: String(row[iNom]),
          firstScn: iFirst < 0 ? 0 : Number(row[iFirst]),
          nextScn: iNext < 0 ? 0 : Number(row[iNext]),
        }));
      }
    }
    const enregistres = this._oracle?.instance.getRuntimeState().archivedLogs ?? [];
    if (enregistres.length > 0) {
      return enregistres.map(l => ({
        thread: l.thread, sequence: l.sequence, path: l.name,
        firstScn: l.firstScn, nextScn: l.nextScn,
      }));
    }
    const onDisk = this.vfs.listFilesRecursively?.(ORACLE_CONFIG.ARCHIVELOG_DIR)
      ?.filter(p => p.endsWith('.arc')).sort() ?? [];
    if (onDisk.length > 0) return onDisk.map((p, i) => archivedLogFromPath(p, i));
    if (this._oracle) return [];
    const sid = this.dbName;
    return [1, 2, 3].map((seq, i) => archivedLogFromPath(
      `${ORACLE_CONFIG.ARCHIVELOG_DIR}/arch_1_${seq}_${sid}.arc`, i));
  }

  private _buildVfsAdapter(): VfsAdapter {
    const dev = this._device as unknown as FsCapableEquipment;
    const read = (path: string): string | null =>
      dev.readFileForEditor?.(path) ?? dev.readFile?.(path) ?? null;
    return {
      writeFile: (path, data, declaredSizeBytes): Result<void, RmanError> => {
        try {
          const size = declaredSizeBytes ?? data.length;
          const body = data.length > 0
            ? new TextDecoder().decode(data)
            : `[ORACLE RMAN BACKUP PIECE - ${size} bytes]`;
          const written = dev.writeFileAsOracle
            ? dev.writeFileAsOracle(path, body, size)
            : dev.writeFileFromEditor(path, body, size);
          if (!written) {
            return err({
              code: 'VFS_WRITE_ERROR',
              message: 'ORA-19504: failed to create file "' + path + '"\n'
                + 'ORA-27040: file create error, unable to create file',
              path,
            });
          }
          return ok(undefined);
        } catch (e) {
          return err({ code: 'VFS_WRITE_ERROR', message: String(e), path });
        }
      },
      readFile: (path): Result<Uint8Array, RmanError> => {
        try {
          return ok(new TextEncoder().encode(read(path) ?? ''));
        } catch (e) {
          return err({ code: 'VFS_READ_ERROR', message: String(e), path });
        }
      },
      fileExists: (path) => {
        try {
          return read(path) !== null;
        } catch { return false; }
      },
      deleteFile: (path): Result<void, RmanError> => {
        try {
          if (dev.deleteFileFromEditor) dev.deleteFileFromEditor(path);
          else dev.deleteFile?.(path);
          return ok(undefined);
        } catch (e) {
          return err({ code: 'VFS_WRITE_ERROR', message: String(e), path });
        }
      },
      availableBytes: () => dev.freeDiskBytes?.() ?? 10_737_418_240,
      listFilesRecursively: (dir): ReadonlyArray<string> => {
        const lister = dev as unknown as {
          executeShellCommandSync?: (cmd: string) => string;
        };
        if (typeof lister.executeShellCommandSync !== 'function') return [];
        const out = lister.executeShellCommandSync(`find ${dir} -type f`);
        return out.split('\n').map(l => l.trim()).filter(l => l.startsWith('/'));
      },
      ensureDirectory: (path): Result<void, RmanError> => {
        if (!dev.makeDirectoryAsOracle) return ok(undefined);
        if (dev.makeDirectoryAsOracle(path)) return ok(undefined);
        return err({
          code: 'VFS_WRITE_ERROR',
          message: 'ORA-19504: failed to create file "' + path + '"\n'
            + 'ORA-27040: file create error, unable to create file',
          path,
        });
      },
    };
  }
}
