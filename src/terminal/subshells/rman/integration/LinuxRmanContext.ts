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
} from './IRmanOracleContext';
import type { HostCapableDevice } from '@/network';
import { resolveOracleConnectTarget } from '@/terminal/commands/oracleNet';
import type { Equipment } from '@/network';
import type { RmanError } from '../core/RmanError';
import type { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { getRegisteredOracleDatabase } from '@/terminal/commands/database';
import { ORACLE_CONFIG } from '@/database/oracle/OracleConfig';
import { recoveryAreaUsage } from '@/database/oracle/storage/RecoveryArea';

interface FsCapableEquipment {
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

  private constructor(
    private readonly _device: Equipment,
    private readonly _oracle: OracleDatabase | null,
  ) {
    const sid = _oracle?.instance.config.sid ?? 'ORCL';
    // Live instances expose their real DBID (same value V$DATABASE
    // shows); the canonical DEFAULT only covers Oracle-less devices.
    this.dbId   = _oracle ? DbId.of(_oracle.instance.getDbId(), sid) : DbId.DEFAULT;
    this.dbName = sid;
    this.vfs    = this._buildVfsAdapter();
  }

  connectTarget(identifier: string): ConnectTargetOutcome {
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
    const oracle = this._oracle;
    if (!oracle) return 0;
    return recoveryAreaUsage(
      oracle.instance.getParameter('db_recovery_file_dest') ?? ORACLE_CONFIG.FRA,
      oracle.instance.getParameter('db_recovery_file_dest_size'),
      oracle.instance.getRuntimeState()).usedBytes;
  }

  getSpfileParam(name: string): string | undefined {
    const key = name.toLowerCase();
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
    return this._oracle?.instance.state ?? 'OPEN';
  }

  getControlFilePath(): string {
    return `${ORADATA_BASE}/${this.dbName}/control01.ctl`;
  }

  getArchivelogPaths(): ReadonlyArray<string> {
    if (this._oracle) {
      return this._oracle.instance.getRuntimeState().archivedLogs.map(l => l.name);
    }
    const sid = this.dbName;
    return [1, 2, 3].map(seq => `${ORACLE_CONFIG.ARCHIVELOG_DIR}/arch_1_${seq}_${sid}.arc`);
  }

  private _buildVfsAdapter(): VfsAdapter {
    const dev = this._device as unknown as FsCapableEquipment;
    const read = (path: string): string | null =>
      dev.readFileForEditor?.(path) ?? dev.readFile?.(path) ?? null;
    return {
      writeFile: (path, _data, declaredSizeBytes): Result<void, RmanError> => {
        try {
          const size = declaredSizeBytes ?? _data.length;
          const body = `[ORACLE RMAN BACKUP PIECE - ${size} bytes]`;
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
