/**
 * V$FILESTAT — per-datafile I/O statistics.
 *
 * Cumulative read/write counts derived from event-fed SQL cache,
 * distributed across datafiles.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$FILESTAT',
  comment: 'Per-datafile I/O statistics',
  query({ storage, runtime }) {
    let bg = 0, dr = 0, exec = 0;
    for (const s of runtime.sqlCache.values()) { bg += s.bufferGets; dr += s.diskReads; exec += s.executions; }
    const datafiles = storage.getAllTablespaces().flatMap(ts =>
      ts.datafiles.map((df, i) => ({ ts: ts.name, file: i + 1 }))
    );
    const n = Math.max(1, datafiles.length);
    return queryResult(
      [
        col.num('FILE#'),
        col.num('PHYRDS'),
        col.num('PHYWRTS'),
        col.num('PHYBLKRD'),
        col.num('PHYBLKWRT'),
        col.num('READTIM'),
        col.num('WRITETIM'),
        col.num('AVGIOTIM'),
      ],
      datafiles.map(df => [
        df.file,
        Math.floor(dr / n), Math.floor(exec / n),
        Math.floor(bg / n), Math.floor(exec / n),
        Math.floor(dr / n) * 10, Math.floor(exec / n) * 10,
        100,
      ])
    );
  },
});
