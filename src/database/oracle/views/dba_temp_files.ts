/**
 * DBA_TEMP_FILES — temp files of TEMPORARY tablespaces.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';
import { parseSize, bytesToBlocks, DEFAULT_BLOCK_SIZE } from './_fileSize';

const UNLIMITED_BYTES = 34359721984;

registerView({
  name: 'DBA_TEMP_FILES',
  comment: 'Temporary data files',
  query({ storage }) {
    const rows: (string | number | null)[][] = [];
    let fileId = 1;
    for (const ts of storage.getAllTablespaces()) {
      if (ts.type !== 'TEMPORARY') continue;
      for (const df of ts.datafiles) {
        const blockSize = ts.blockSize || DEFAULT_BLOCK_SIZE;
        const bytes = parseSize(df.size);
        const blocks = bytesToBlocks(bytes, blockSize);
        const maxBytes = df.autoextend ? UNLIMITED_BYTES : bytes;
        const userBytes = Math.max(bytes - 65536, 0);
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
          bytesToBlocks(maxBytes, blockSize),
          df.autoextend ? bytesToBlocks(8 * 1024 * 1024, blockSize) : 0,
          userBytes,
          bytesToBlocks(userBytes, blockSize),
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
      ],
      rows
    );
  },
});
