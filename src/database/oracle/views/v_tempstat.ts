/**
 * V$TEMPSTAT — per-tempfile I/O statistics.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$TEMPSTAT',
  comment: 'Per-tempfile I/O statistics',
  query({ storage, runtime }) {
    const tempfiles = storage.getAllTablespaces()
      .filter(ts => ts.type === 'TEMPORARY')
      .flatMap(ts => ts.datafiles.map((_, i) => ({ ts: ts.name, file: i + 1 })));
    return queryResult(
      [
        col.num('FILE#'),
        col.num('PHYRDS'),
        col.num('PHYWRTS'),
        col.num('PHYBLKRD'),
        col.num('PHYBLKWRT'),
        col.num('READTIM'),
        col.num('WRITETIM'),
      ],
      tempfiles.map(df => [
        df.file,
        runtime.counters.executions, runtime.counters.executions,
        runtime.counters.executions * 8, runtime.counters.executions * 8,
        runtime.counters.executions * 5, runtime.counters.executions * 5,
      ])
    );
  },
});
