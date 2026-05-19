/**
 * DBA_COL_PRIVS — column-level grants. Empty unless granted explicitly.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_COL_PRIVS',
  comment: 'Column-level grants',
  query({ catalog }) {
    return queryResult(
      [
        col.str('GRANTEE', 128),
        col.str('OWNER', 128),
        col.str('TABLE_NAME', 128),
        col.str('COLUMN_NAME', 128),
        col.str('GRANTOR', 128),
        col.str('PRIVILEGE', 40),
        col.str('GRANTABLE', 3),
      ],
      catalog.getColumnPrivileges().map(p => [
        p.grantee, p.objectSchema, p.objectName, p.columnName, p.grantor, p.privilege,
        p.grantable ? 'YES' : 'NO',
      ]),
    );
  },
});
