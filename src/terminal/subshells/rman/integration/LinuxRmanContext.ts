/**
 * LinuxRmanContext — adapts an Equipment (LinuxServer / LinuxPC) to
 * IRmanOracleContext for the RMAN session.
 *
 * VFS writes go through the device's `writeFileFromEditor` which is the
 * stable cross-device file-write surface.
 */

import { DbId } from '../values/DbId';
import { ok, err, type Result } from '../core/Result';
import type { IRmanOracleContext, DatafileInfo, VfsAdapter } from './IRmanOracleContext';
import type { Equipment } from '@/network';
import type { RmanError } from '../core/RmanError';

/** Shape of an Equipment that exposes the optional readFile/deleteFile methods. */
interface FsCapableEquipment {
  writeFileFromEditor(path: string, content: string): boolean;
  readFile?(path: string): string | null;
  deleteFile?(path: string): boolean;
}

export class LinuxRmanContext implements IRmanOracleContext {
  readonly dbId: DbId;
  readonly dbName: string;
  readonly vfs: VfsAdapter;

  private constructor(private readonly _device: Equipment) {
    this.dbId   = DbId.DEFAULT;
    this.dbName = 'ORCL';
    this.vfs    = this._buildVfsAdapter();
  }

  static forDevice(device: Equipment): LinuxRmanContext {
    return new LinuxRmanContext(device);
  }

  getDatafiles(): ReadonlyArray<DatafileInfo> {
    return [
      { fileNo: 1, path: '/u01/app/oracle/oradata/ORCL/system01.dbf',  sizeBytes: 838_860_800, tablespace: 'SYSTEM'   },
      { fileNo: 2, path: '/u01/app/oracle/oradata/ORCL/sysaux01.dbf',  sizeBytes: 576_716_800, tablespace: 'SYSAUX'   },
      { fileNo: 3, path: '/u01/app/oracle/oradata/ORCL/undotbs01.dbf', sizeBytes: 209_715_200, tablespace: 'UNDOTBS1' },
      { fileNo: 4, path: '/u01/app/oracle/oradata/ORCL/users01.dbf',   sizeBytes: 104_857_600, tablespace: 'USERS'    },
    ];
  }

  getSpfileParam(name: string): string | undefined {
    const map: Record<string, string> = {
      db_name:               this.dbName,
      db_recovery_file_dest: '/u01/backup',
      control_files:         '/u01/app/oracle/oradata/ORCL/control01.ctl',
    };
    return map[name.toLowerCase()];
  }

  private _buildVfsAdapter(): VfsAdapter {
    const dev = this._device as unknown as FsCapableEquipment;
    return {
      writeFile: (path, _data): Result<void, RmanError> => {
        try {
          // Materialise as Oracle-style metadata marker. Content size is
          // taken from the data length so capture actors / FS sync stays
          // consistent.
          const content = `[ORACLE RMAN BACKUP PIECE - ${_data.length} bytes]`;
          dev.writeFileFromEditor(path, content);
          return ok(undefined);
        } catch (e) {
          return err({ code: 'VFS_WRITE_ERROR', message: String(e), path });
        }
      },
      readFile: (path): Result<Uint8Array, RmanError> => {
        try {
          const s = dev.readFile?.(path) ?? '';
          return ok(new TextEncoder().encode(s));
        } catch (e) {
          return err({ code: 'VFS_READ_ERROR', message: String(e), path });
        }
      },
      fileExists: (path) => {
        try {
          const s = dev.readFile?.(path);
          return typeof s === 'string';
        } catch { return false; }
      },
      deleteFile: (path): Result<void, RmanError> => {
        try {
          dev.deleteFile?.(path);
          return ok(undefined);
        } catch (e) {
          return err({ code: 'VFS_WRITE_ERROR', message: String(e), path });
        }
      },
      availableBytes: () => 10_737_418_240,
    };
  }
}
