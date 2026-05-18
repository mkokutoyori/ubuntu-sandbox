/**
 * DBA_HIST_WR_CONTROL — AWR retention/interval configuration.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_HIST_WR_CONTROL',
  comment: 'AWR retention configuration',
  query() {
    return queryResult(
      [
        col.num('DBID'),
        col.str('SNAP_INTERVAL', 24),
        col.str('RETENTION', 24),
        col.str('TOPNSQL', 24),
      ],
      [[1234567890, '+00 01:00:00.0', '+08 00:00:00.0', 'DEFAULT']]
    );
  },
});
