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
import type { IRmanOracleContext, DatafileInfo, VfsAdapter } from './IRmanOracleContext';
import type { Equipment } from '@/network';
import type { RmanError } from '../core/RmanError';
import type { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { getRegisteredOracleDatabase } from '@/terminal/commands/database';

interface FsCapableEquipment {
  writeFileFromEditor(path: string, content: string): boolean;
  readFileForEditor?(path: string): string | null;
  readFile?(path: string): string | null;
  deleteFileFromEditor?(path: string): boolean;
  deleteFile?(path: string): boolean;
}

const ORADATA_BASE = '/u01/app/oracle/oradata';
const BACKUP_BASE  = '/u01/backup';

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

  getSpfileParam(name: string): string | undefined {
    const sid = this.dbName;
    const map: Record<string, string> = {
      db_name:               sid,
      db_unique_name:        sid,
      instance_name:         sid,
      service_names:         this._oracle?.instance.config.serviceName ?? sid,
      db_recovery_file_dest: BACKUP_BASE,
      control_files:         `${ORADATA_BASE}/${sid}/control01.ctl`,
    };
    return map[name.toLowerCase()];
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
    return [1, 2, 3].map(seq => `${BACKUP_BASE}/archivelog/arch_1_${seq}_${sid}.arc`);
  }

  private _buildVfsAdapter(): VfsAdapter {
    const dev = this._device as unknown as FsCapableEquipment;
    const read = (path: string): string | null =>
      dev.readFileForEditor?.(path) ?? dev.readFile?.(path) ?? null;
    return {
      writeFile: (path, _data): Result<void, RmanError> => {
        try {
          dev.writeFileFromEditor(path, `[ORACLE RMAN BACKUP PIECE - ${_data.length} bytes]`);
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
      availableBytes: () => 10_737_418_240,
    };
  }
}
