/**
 * USER_TAB_PRIVS_RECD — object privileges granted to the current
 * user (received). Native Oracle view.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'USER_TAB_PRIVS_RECD',
  comment: 'Object privileges received by the current user',
  query({ catalog, currentUser }) {
    const upper = currentUser.toUpperCase();
    const rows: (string | null)[][] = [];
    for (const p of catalog.getTablePrivilegeGrants()) {
      if (p.grantee.toUpperCase() !== upper) continue;
      const grantor = ((p as { grantor?: string }).grantor ?? p.objectSchema ?? 'SYS').toUpperCase();
      rows.push([
        p.objectSchema ?? 'SYS', p.objectName ?? '', grantor, p.privilege,
        p.grantable ? 'YES' : 'NO', 'NO', 'TABLE', 'NO',
      ]);
    }
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('TABLE_NAME', 128),
        col.str('GRANTOR', 128),
        col.str('PRIVILEGE', 40),
        col.str('GRANTABLE', 3),
        col.str('HIERARCHY', 3),
        col.str('OBJECT_TYPE', 23),
        col.str('INHERITED', 3),
      ],
      rows,
    );
  },
});
