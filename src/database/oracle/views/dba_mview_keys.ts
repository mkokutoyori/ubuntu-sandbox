/**
 * DBA_MVIEW_KEYS — columns used as the key of an MV.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_MVIEW_KEYS',
  comment: 'Materialised view key columns',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('MVIEW_NAME', 30),
        col.num('POSITION'),
        col.str('CONTAINER_COLUMN', 30),
        col.str('DETAILOBJ_OWNER', 30),
        col.str('DETAILOBJ_NAME', 30),
        col.str('DETAILOBJ_TYPE', 12),
      ],
      []
    );
  },
});
