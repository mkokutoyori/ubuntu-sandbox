/**
 * USER_TAB_PRIVS_MADE — object privileges the current user has
 * granted to others. Native Oracle view.
 *
 * The catalog does not always carry an explicit `grantor` field;
 * when missing real Oracle defaults to the object owner — we do the
 * same so DBA scripts work unmodified.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'USER_TAB_PRIVS_MADE',
  comment: 'Object privileges granted to others by the current user',
  query({ catalog, currentUser }) {
    const upper = currentUser.toUpperCase();
    const rows: (string | null)[][] = [];
    for (const p of catalog.getTablePrivilegeGrants()) {
      const grantor = ((p as { grantor?: string }).grantor ?? p.objectSchema ?? 'SYS').toUpperCase();
      if (grantor !== upper) continue;
      rows.push([
        p.grantee,
        p.objectName ?? '',
        grantor,
        p.privilege,
        p.grantable ? 'YES' : 'NO',
        'NO', 'TABLE', 'NO',
      ]);
    }
    return queryResult(
      [
        col.str('GRANTEE', 128),
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
