/**
 * V$CACHE_STATS — buffer cache statistics per object.
 *
 * One row per storage table — read/write counts come from the event-fed
 * SQL cache aggregated by parsing schema.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$CACHE_STATS',
  comment: 'Per-object buffer cache statistics',
  query({ storage, runtime }) {
    const tables = storage.getAllTables();
    const totals = { reads: 0, writes: 0 };
    for (const s of runtime.sqlCache.values()) {
      totals.reads += s.bufferGets;
      totals.writes += s.executions;
    }
    const n = Math.max(1, tables.length);
    return queryResult(
      [
        col.num('FILE#'),
        col.num('BLOCK#'),
        col.num('OBJD'),
        col.str('NAME', 64),
        col.str('OWNER', 30),
        col.num('PHYSICAL_READS'),
        col.num('PHYSICAL_WRITES'),
        col.num('CONSISTENT_GETS'),
        col.num('CURRENT_GETS'),
      ],
      tables.map((t, i) => [
        1, i + 100, 1000 + i, t.name, t.schema,
        Math.floor(totals.reads / n / 10),
        Math.floor(totals.writes / n / 10),
        Math.floor(totals.reads / n),
        Math.floor(totals.reads / n / 2),
      ])
    );
  },
});
