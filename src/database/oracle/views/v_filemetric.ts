/**
 * V$FILEMETRIC — per-datafile current I/O metrics snapshot.
 *
 * Derived from event-fed SQL cache aggregates spread across datafiles.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$FILEMETRIC',
  comment: 'Per-datafile current I/O metrics',
  query({ storage, runtime }) {
    let reads = 0, writes = 0;
    for (const s of runtime.sqlCache.values()) {
      reads += s.diskReads;
      writes += s.executions;
    }
    const datafiles = storage.getAllTablespaces().flatMap(ts =>
      ts.datafiles.map((df, i) => ({ ts: ts.name, file: i + 1, path: df.path }))
    );
    const n = Math.max(1, datafiles.length);
    const end = Date.now();
    return queryResult(
      [
        col.date('BEGIN_TIME'),
        col.date('END_TIME'),
        col.num('INTSIZE_CSEC'),
        col.num('FILE_ID'),
        col.num('AVERAGE_READ_TIME'),
        col.num('AVERAGE_WRITE_TIME'),
        col.num('PHYSICAL_READ'),
        col.num('PHYSICAL_WRITE'),
      ],
      datafiles.map(df => [
        new Date(end - 60_000).toISOString(), new Date(end).toISOString(),
        6000, df.file, 100, 100,
        Math.floor(reads / n), Math.floor(writes / n),
      ])
    );
  },
});
