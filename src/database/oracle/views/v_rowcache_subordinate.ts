/**
 * V$ROWCACHE_SUBORDINATE — sub-cache statistics.
 *
 * Empty by default (we model only parent caches in V$ROWCACHE).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$ROWCACHE_SUBORDINATE',
  comment: 'Subordinate row cache statistics',
  query() {
    return queryResult(
      [
        col.num('CACHE#'),
        col.num('SUBORDINATE#'),
        col.str('PARAMETER', 35),
        col.num('GETS'),
        col.num('GETMISSES'),
      ],
      []
    );
  },
});
