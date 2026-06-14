/**
 * DBA_HIST_BASELINE — AWR baselines (named ranges of snapshots).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_HIST_BASELINE',
  comment: 'AWR baselines',
  query({ instance }) {
    return queryResult(
      [
        col.num('DBID'),
        col.num('BASELINE_ID'),
        col.str('BASELINE_NAME', 64),
        col.str('BASELINE_TYPE', 13),
        col.num('START_SNAP_ID'),
        col.date('START_SNAP_TIME'),
        col.num('END_SNAP_ID'),
        col.date('END_SNAP_TIME'),
      ],
      [
        [instance.getDbId(), 0, 'SYSTEM_MOVING_WINDOW', 'MOVING_WINDOW',
          null as unknown as number, null as unknown as string,
          null as unknown as number, null as unknown as string],
      ]
    );
  },
});
