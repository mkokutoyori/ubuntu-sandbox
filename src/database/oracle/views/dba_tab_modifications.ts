/**
 * DBA_TAB_MODIFICATIONS — DML modifications since last stats gather.
 *
 * Derived from event-fed counters spread across tables (event source:
 * oracle.dml.executed). Each table receives a proportional share of
 * the current dml counter.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TAB_MODIFICATIONS',
  comment: 'DML modifications since last stats',
  query({ storage, runtime }) {
    const tables = storage.getAllTables();
    const n = Math.max(1, tables.length);
    const slice = (v: number) => Math.floor(v / n);
    return queryResult(
      [
        col.str('TABLE_OWNER', 30),
        col.str('TABLE_NAME', 30),
        col.num('INSERTS'),
        col.num('UPDATES'),
        col.num('DELETES'),
        col.date('TIMESTAMP'),
        col.str('TRUNCATED', 3),
        col.num('DROP_SEGMENTS'),
      ],
      tables.map(t => [
        t.schema, t.name,
        slice(runtime.counters.dml),
        slice(runtime.counters.dml),
        slice(runtime.counters.dml),
        new Date().toISOString(),
        'NO', 0,
      ])
    );
  },
});
