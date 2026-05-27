/**
 * DBA_OBJECT_USAGE — index usage monitoring (native Oracle 12c+,
 * replaces V$OBJECT_USAGE from 9i/11g). Populated by
 * ALTER INDEX … MONITORING USAGE.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_OBJECT_USAGE',
  comment: 'Index usage monitoring',
  query({ instance }) {
    const mon = instance.getIndexUsageMonitor();
    const records = mon ? mon.getRecords() : [];
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('INDEX_NAME', 128),
        col.str('TABLE_NAME', 128),
        col.str('MONITORING', 3),
        col.str('USED', 3),
        col.str('START_MONITORING', 30),
        col.str('END_MONITORING', 30),
      ],
      records.map(r => [
        r.owner, r.indexName, r.tableName,
        r.monitoring ? 'YES' : 'NO',
        r.used ? 'YES' : 'NO',
        r.startMonitoring ? r.startMonitoring.toISOString() : '',
        r.endMonitoring ? r.endMonitoring.toISOString() : '',
      ]),
    );
  },
});

// V$OBJECT_USAGE — 9i/11g name still queried by some legacy scripts.
registerView({
  name: 'V$OBJECT_USAGE',
  comment: 'Index usage monitoring (per-session view)',
  query({ instance }) {
    const mon = instance.getIndexUsageMonitor();
    const records = mon ? mon.getRecords() : [];
    return queryResult(
      [
        col.str('INDEX_NAME', 128),
        col.str('TABLE_NAME', 128),
        col.str('MONITORING', 3),
        col.str('USED', 3),
        col.str('START_MONITORING', 30),
        col.str('END_MONITORING', 30),
      ],
      records.map(r => [
        r.indexName, r.tableName,
        r.monitoring ? 'YES' : 'NO',
        r.used ? 'YES' : 'NO',
        r.startMonitoring ? r.startMonitoring.toISOString() : '',
        r.endMonitoring ? r.endMonitoring.toISOString() : '',
      ]),
    );
  },
});
