/**
 * V$IOSTAT_FILE — per-file I/O statistics.
 *
 * Rows mirror the real datafile list reported by the storage layer,
 * and the I/O byte counts are derived from the same runtime SQL cache
 * V\$FILESTAT consumes (no hardcoded numbers — empty cache → all zeros).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$IOSTAT_FILE',
  comment: 'Per-file I/O statistics',
  query({ storage, runtime }) {
    let bg = 0, dr = 0, exec = 0;
    for (const s of runtime.sqlCache.values()) { bg += s.bufferGets; dr += s.diskReads; exec += s.executions; }
    const datafiles: { file: number; path: string; type: 'Data File' | 'Temp File' }[] = [];
    let n = 0;
    for (const ts of storage.getAllTablespaces()) {
      const type = ts.type === 'TEMPORARY' ? 'Temp File' : 'Data File';
      for (const df of ts.datafiles) { n++; datafiles.push({ file: n, path: df.path, type }); }
    }
    const denom = Math.max(1, datafiles.length);
    const perFileReads = Math.floor(dr / denom);
    const perFileWrites = Math.floor(exec / denom);
    const blockBytes = 8192;
    return queryResult(
      [
        { name: 'FILE_NO', dataType: oracleNumber(10) },
        { name: 'FILENAME', dataType: oracleVarchar2(513) },
        { name: 'FILETYPE_NAME', dataType: oracleVarchar2(20) },
        { name: 'SMALL_READ_MEGABYTES', dataType: oracleNumber(20) },
        { name: 'SMALL_WRITE_MEGABYTES', dataType: oracleNumber(20) },
        { name: 'LARGE_READ_MEGABYTES', dataType: oracleNumber(20) },
        { name: 'LARGE_WRITE_MEGABYTES', dataType: oracleNumber(20) },
        { name: 'SMALL_READ_REQS', dataType: oracleNumber(20) },
        { name: 'SMALL_WRITE_REQS', dataType: oracleNumber(20) },
        { name: 'LARGE_READ_REQS', dataType: oracleNumber(20) },
        { name: 'LARGE_WRITE_REQS', dataType: oracleNumber(20) },
        { name: 'TOTAL_IO', dataType: oracleNumber(20) },
      ],
      datafiles.map(df => [
        df.file, df.path, df.type,
        Math.floor(perFileReads * blockBytes / (1024 * 1024)),
        Math.floor(perFileWrites * blockBytes / (1024 * 1024)),
        0, 0,
        perFileReads, perFileWrites,
        0, 0,
        perFileReads + perFileWrites,
      ])
    );
  },
});
