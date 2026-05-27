/**
 * ALL_TAB_PRIVS_MADE — object privileges granted by the current user
 * or by users on whose tables the current user has privileges.
 * Native Oracle view.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'ALL_TAB_PRIVS_MADE',
  comment: 'Object privileges visible to the current user',
  query({ catalog, currentUser }) {
    const upper = currentUser.toUpperCase();
    const rows: (string | null)[][] = [];
    for (const p of catalog.getTablePrivilegeGrants()) {
      const grantor = ((p as { grantor?: string }).grantor ?? p.objectSchema ?? 'SYS').toUpperCase();
      const owner = (p.objectSchema ?? 'SYS').toUpperCase();
      if (grantor !== upper && owner !== upper) continue;
      rows.push([
        p.grantee, owner, p.objectName ?? '', grantor, p.privilege,
        p.grantable ? 'YES' : 'NO', 'NO', 'TABLE', 'NO',
      ]);
    }
    return queryResult(
      [
        col.str('GRANTEE', 128),
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
