/**
 * DBA_RECYCLEBIN — dropped objects awaiting purge.
 *
 * We don't currently retain dropped objects in storage, so this view is
 * empty until the engine begins tracking them.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_RECYCLEBIN',
  comment: 'Recyclebin contents',
  query() {
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('OBJECT_NAME', 30),
        col.str('ORIGINAL_NAME', 32),
        col.str('OPERATION', 9),
        col.str('TYPE', 25),
        col.str('TS_NAME', 30),
        col.str('CREATETIME', 19),
        col.str('DROPTIME', 19),
        col.num('SPACE'),
      ],
      []
    );
  },
});
