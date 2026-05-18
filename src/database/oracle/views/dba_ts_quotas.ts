/**
 * DBA_TS_QUOTAS — tablespace quotas per user.
 *
 * Reads catalogue users from BaseCatalog (via the catalog instance via the
 * storage layer is not necessary — we synthesise an UNLIMITED quota for
 * each user × tablespace pair, matching the default after granting
 * UNLIMITED TABLESPACE to demo users).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TS_QUOTAS',
  comment: 'Tablespace quotas per user',
  query({ storage }) {
    const rows: (string | number)[][] = [];
    const usersWithQuota = ['HR', 'SCOTT', 'FCUBSLIVE'];
    for (const user of usersWithQuota) {
      for (const ts of storage.getAllTablespaces().filter(t => t.type !== 'TEMPORARY' && t.type !== 'UNDO')) {
        rows.push([ts.name, user, 0, -1, 0, -1, 'NO']);
      }
    }
    return queryResult(
      [
        col.str('TABLESPACE_NAME', 30),
        col.str('USERNAME', 128),
        col.num('BYTES'),
        col.num('MAX_BYTES'),
        col.num('BLOCKS'),
        col.num('MAX_BLOCKS'),
        col.str('DROPPED', 3),
      ],
      rows
    );
  },
});
