/**
 * V$ROWCACHE — data dictionary cache stats.
 *
 * Hit ratios are derived from event-fed counters (parseTotal, parseHard).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const CACHES = [
  'dc_users', 'dc_objects', 'dc_segments', 'dc_tablespaces',
  'dc_rollback_segments', 'dc_sequences', 'dc_synonyms',
  'dc_table_grants', 'dc_user_grants', 'dc_profiles', 'dc_constraints',
];

registerView({
  name: 'V$ROWCACHE',
  comment: 'Data dictionary cache statistics',
  query({ runtime }) {
    const gets = Math.max(1, runtime.counters.parseTotal);
    const misses = runtime.counters.parseHard;
    return queryResult(
      [
        col.num('CACHE#'),
        col.str('TYPE', 9),
        col.str('PARAMETER', 35),
        col.num('COUNT'),
        col.num('USAGE'),
        col.num('FIXED'),
        col.num('GETS'),
        col.num('GETMISSES'),
        col.num('SCANS'),
        col.num('SCANMISSES'),
        col.num('MODIFICATIONS'),
        col.num('FLUSHES'),
      ],
      CACHES.map((n, idx) => [
        idx, 'PARENT', n, 100, 80, 16, Math.floor(gets / CACHES.length),
        Math.floor(misses / CACHES.length), 0, 0, 0, 0,
      ])
    );
  },
});
