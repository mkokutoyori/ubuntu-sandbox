/**
 * DBA_UNUSED_OBJPRIVS — object privileges granted but never used.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_UNUSED_OBJPRIVS',
  comment: 'Granted but unused object privileges',
  query({ catalog, instance }) {
    const used = new Set(
      instance.getAuditJournal().getPrivilegeUsage()
        .filter(r => r.objectName)
        .map(r => `${r.username}|${r.privilege}|${r.objectSchema}.${r.objectName}`),
    );
    const rows: string[][] = [];
    const seen = new Set<string>();
    for (const tp of catalog.getTablePrivilegeGrants()) {
      const k = `${tp.grantee}|${tp.privilege}|${tp.objectSchema}.${tp.objectName}`;
      if (used.has(k) || seen.has(k)) continue;
      seen.add(k);
      rows.push([
        'ORA_$DEPENDENCY', tp.grantee, tp.privilege,
        tp.objectSchema, tp.objectName, 'TABLE',
      ]);
    }
    return queryResult(
      [
        col.str('CAPTURE', 128),
        col.str('USERNAME', 128),
        col.str('OBJ_PRIV', 128),
        col.str('OBJECT_OWNER', 128),
        col.str('OBJECT_NAME', 128),
        col.str('OBJECT_TYPE', 23),
      ],
      rows,
    );
  },
});
