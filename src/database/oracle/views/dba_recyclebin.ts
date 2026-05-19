/**
 * DBA_RECYCLEBIN — soft-dropped objects. Backed by the real
 * recyclebin maintained on OracleCatalog; DROP TABLE (without PURGE)
 * adds a row, FLASHBACK … TO BEFORE DROP / PURGE removes it.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_RECYCLEBIN',
  comment: 'Recyclebin contents',
  query({ catalog }) {
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
      catalog.getRecyclebin().map(r => [
        r.owner, r.objectName, r.originalName,
        'DROP', r.type, r.tsName,
        r.droptime.toISOString().slice(0, 19).replace('T', ' '),
        r.droptime.toISOString().slice(0, 19).replace('T', ' '),
        r.space,
      ]),
    );
  },
});
