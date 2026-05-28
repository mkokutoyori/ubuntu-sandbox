/**
 * ALL_TAB_PRIVS_RECD — object privileges accessible to the current
 * user (directly granted or via PUBLIC / roles). Native Oracle view.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'ALL_TAB_PRIVS_RECD',
  comment: 'Object privileges received by the current user',
  query({ catalog, currentUser }) {
    const upper = currentUser.toUpperCase();
    // Expand granted roles so privileges held transitively also surface.
    const expansion = new Set<string>([upper, 'PUBLIC']);
    const queue: string[] = [upper];
    while (queue.length) {
      const g = queue.shift()!;
      for (const r of catalog.getRoleGrants()) {
        if (r.grantee.toUpperCase() !== g) continue;
        const role = r.role.toUpperCase();
        if (!expansion.has(role)) { expansion.add(role); queue.push(role); }
      }
    }
    const rows: (string | null)[][] = [];
    for (const p of catalog.getTablePrivilegeGrants()) {
      if (!expansion.has(p.grantee.toUpperCase())) continue;
      const grantor = ((p as { grantor?: string }).grantor ?? p.objectSchema ?? 'SYS').toUpperCase();
      rows.push([
        p.grantee, p.objectSchema ?? 'SYS', p.objectName ?? '', grantor, p.privilege,
        p.grantable ? 'YES' : 'NO', 'NO', 'TABLE',
        p.grantee.toUpperCase() === upper ? 'NO' : 'YES',
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
