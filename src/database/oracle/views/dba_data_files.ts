/**
 * DBA_DATA_FILES — permanent data files. Temporary tablespaces live
 * in DBA_TEMP_FILES, never here (cross-validation with V$DATAFILE
 * depends on this exclusion).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';
import { parseSize, bytesToBlocks, DEFAULT_BLOCK_SIZE, UNLIMITED_DATAFILE_BYTES } from './_fileSize';

registerView({
  name: 'DBA_DATA_FILES',
  comment: 'Data files',
  query({ storage }) {
    const rows: (string | number | null)[][] = [];
    let fileId = 1;
    for (const ts of storage.getAllTablespaces()) {
      if (ts.type === 'TEMPORARY') continue;
      for (const df of ts.datafiles) {
        const bytes = parseSize(df.size);
        const blocks = bytesToBlocks(bytes, ts.blockSize || DEFAULT_BLOCK_SIZE);
        const maxBytes = df.autoextend
          ? (df.maxSize && df.maxSize.toUpperCase() !== 'UNLIMITED' ? parseSize(df.maxSize) : UNLIMITED_DATAFILE_BYTES)
          : bytes;
        const maxBlocks = bytesToBlocks(maxBytes, ts.blockSize || DEFAULT_BLOCK_SIZE);
        const userBytes = Math.max(bytes - 65536, 0); // 8 reserved blocks header
        const userBlocks = bytesToBlocks(userBytes, ts.blockSize || DEFAULT_BLOCK_SIZE);
        rows.push([
          fileId++,
          df.path,
          ts.name,
          bytes,
          blocks,
          'AVAILABLE',
          1,
          df.autoextend ? 'YES' : 'NO',
          maxBytes,
          maxBlocks,
          df.autoextend ? bytesToBlocks(8 * 1024 * 1024, ts.blockSize || DEFAULT_BLOCK_SIZE) : 0,
          userBytes,
          userBlocks,
          ts.status === 'OFFLINE' ? 'OFFLINE' : 'ONLINE',
        ]);
      }
    }
    return queryResult(
      [
        { name: 'FILE_ID', dataType: oracleNumber(10) },
        { name: 'FILE_NAME', dataType: oracleVarchar2(513) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
        { name: 'STATUS', dataType: oracleVarchar2(9) },
        { name: 'RELATIVE_FNO', dataType: oracleNumber(10) },
        { name: 'AUTOEXTENSIBLE', dataType: oracleVarchar2(3) },
        { name: 'MAXBYTES', dataType: oracleNumber(20) },
        { name: 'MAXBLOCKS', dataType: oracleNumber(20) },
        { name: 'INCREMENT_BY', dataType: oracleNumber(20) },
        { name: 'USER_BYTES', dataType: oracleNumber(20) },
        { name: 'USER_BLOCKS', dataType: oracleNumber(20) },
        { name: 'ONLINE_STATUS', dataType: oracleVarchar2(7) },
      ],
      rows
    );
  },
});
