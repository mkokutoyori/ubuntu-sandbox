/**
 * V$DISPATCHER_RATE — dispatcher rate metrics.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$DISPATCHER_RATE',
  comment: 'Dispatcher rate metrics',
  query({ instance }) {
    const cfg = instance.getParameter('dispatchers') ?? '';
    return queryResult(
      [
        col.str('NAME', 4),
        col.num('PAGED'),
        col.num('FOUND'),
        col.num('CUR_LOOP_RATE'),
        col.num('AVG_LOOP_RATE'),
        col.num('MAX_LOOP_RATE'),
      ],
      cfg ? [['D000', 0, 0, 0, 0, 0]] : []
    );
  },
});
