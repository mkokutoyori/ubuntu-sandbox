/**
 * V$EVENT_HISTOGRAM — per-event wait-time distribution histogram.
 * Native Oracle 10g+. Each row holds (event, wait class, bucket upper
 * bound in milliseconds, wait count). Populated by WaitEventEngine.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$EVENT_HISTOGRAM',
  comment: 'Wait-time histogram per event',
  query({ instance }) {
    const rows = instance.getWaitEngine()?.getEventHistogram() ?? [];
    return queryResult(
      [
        col.str('EVENT', 64),
        col.num('WAIT_TIME_MILLI'),
        col.num('WAIT_COUNT'),
        col.str('WAIT_CLASS', 64),
        col.num('LAST_UPDATE_TIME'),
      ],
      rows.map(r => [r.event, r.waitTimeMilliBucket, r.waitCount, r.waitClass, 0]),
    );
  },
});
