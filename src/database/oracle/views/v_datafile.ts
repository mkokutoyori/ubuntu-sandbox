/**
 * V$DATAFILE — permanent data files. Temporary files belong to
 * V$TEMPFILE. The dictionary cross-validation
 *   SELECT COUNT(*) FROM v$datafile = SELECT COUNT(*) FROM dba_data_files
 * relies on this exclusion.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';
import { parseSize } from './_fileSize';

/** Stable, deterministic creation timestamp for the seeded datafiles. */
const DEFAULT_CREATION_TIME = new Date('2026-01-01T00:00:00Z');

registerView({
  name: 'V$DATAFILE',
  comment: 'Data file information',
  query({ storage, instance }) {
    const rows: (string | number | Date | null)[][] = [];
    let fileNum = 1;
    let tsNum = 0;
    for (const ts of storage.getAllTablespaces()) {
      // TS# identifies the tablespace: every datafile of one tablespace
      // shares it (real Oracle stores it in the control file).
      const currentTsNum = tsNum++;
      if (ts.type === 'TEMPORARY') continue;
      for (const df of ts.datafiles) {
        const bytes = parseSize(df.size);
        rows.push([
          fileNum,
          df.path,
          currentTsNum,
          ts.name,
          bytes,
          ts.blockSize || 8192,
          ts.status === 'OFFLINE' ? 'OFFLINE' : 'ONLINE',
          'AVAILABLE',
          DEFAULT_CREATION_TIME,
          // One consistent checkpoint SCN across all headers — agrees
          // with V$DATAFILE_HEADER and V$DATABASE.CHECKPOINT_CHANGE#.
          instance.getCheckpointScn(),
          instance.getCheckpointTime(),
          df.autoextend ? 'YES' : 'NO',
        ]);
        fileNum++;
      }
    }
    return queryResult(
      [
        { name: 'FILE#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(513) },
        { name: 'TS#', dataType: oracleNumber(10) },
        { name: 'TS#_NAME', dataType: oracleVarchar2(30) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'BLOCK_SIZE', dataType: oracleNumber(10) },
        { name: 'STATUS', dataType: oracleVarchar2(7) },
        { name: 'ENABLED', dataType: oracleVarchar2(10) },
        { name: 'CREATION_TIME', dataType: oracleDate() },
        { name: 'CHECKPOINT_CHANGE#', dataType: oracleNumber(20) },
        { name: 'CHECKPOINT_TIME', dataType: oracleDate() },
        { name: 'AUTOEXTENSIBLE', dataType: oracleVarchar2(3) },
        { name: 'RECOVER', dataType: oracleVarchar2(3) },
      ],
      rows.map(r => [...r, 'NO'])
    );
  },
});
