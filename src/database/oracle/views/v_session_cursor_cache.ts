/**
 * V$SESSION_CURSOR_CACHE — session cursor cache statistics.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION_CURSOR_CACHE',
  comment: 'Per-session cursor cache stats',
  query({ runtime, instance }) {
    const max = Number(instance.getParameter('open_cursors') ?? '300');
    return queryResult(
      [
        col.num('MAXIMUM'),
        col.num('COUNT'),
        col.num('OPENED_ONCE'),
        col.num('OPEN'),
        col.num('OPENS'),
        col.num('HITS'),
        col.num('HIT_RATIO'),
      ],
      [[
        max, runtime.sqlCache.size,
        runtime.counters.executions, runtime.sqlCache.size,
        runtime.counters.parseTotal,
        runtime.counters.parseTotal - runtime.counters.parseHard,
        runtime.counters.parseTotal > 0
          ? (runtime.counters.parseTotal - runtime.counters.parseHard) / runtime.counters.parseTotal
          : 1,
      ]]
    );
  },
});
