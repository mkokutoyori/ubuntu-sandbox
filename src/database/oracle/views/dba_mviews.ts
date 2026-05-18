/**
 * DBA_MVIEWS — materialised views. Empty unless explicitly created.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_MVIEWS',
  comment: 'Materialised views',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('MVIEW_NAME', 30),
        col.str('CONTAINER_NAME', 30),
        col.str('REFRESH_MODE', 6),
        col.str('REFRESH_METHOD', 8),
        col.str('BUILD_MODE', 9),
        col.str('STALENESS', 18),
      ],
      []
    );
  },
});
