/**
 * DBA_UNUSED_PRIVS — privileges granted but never used during capture.
 * Computed as (granted privileges) − (used privileges).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_UNUSED_PRIVS',
  comment: 'Granted but unused privileges',
  query({ catalog, instance }) {
    const usage = instance.getAuditJournal().getPrivilegeUsage();
    const usedKey = new Set(usage.map(r => `${r.username}|${r.privilege}`));
    const rows: (string | null)[][] = [];
    const seen = new Set<string>();
    for (const sp of catalog.getSysPrivilegeGrants()) {
      const k = `${sp.grantee}|${sp.privilege}`;
      if (usedKey.has(k) || seen.has(k)) continue;
      seen.add(k);
      rows.push([
        'ORA_$DEPENDENCY', sp.grantee, sp.privilege, sp.privilege, null, null, null,
      ]);
    }
    for (const tp of catalog.getTablePrivilegeGrants()) {
      const k = `${tp.grantee}|${tp.privilege}`;
      if (usedKey.has(k) || seen.has(k)) continue;
      seen.add(k);
      rows.push([
        'ORA_$DEPENDENCY', tp.grantee, tp.privilege, null, tp.privilege, tp.objectSchema, tp.objectName,
      ]);
    }
    return queryResult(
      [
        col.str('CAPTURE', 128),
        col.str('USERNAME', 128),
        col.str('PATH', 4000),
        col.str('SYS_PRIV', 128),
        col.str('OBJ_PRIV', 128),
        col.str('OBJECT_OWNER', 128),
        col.str('OBJECT_NAME', 128),
      ],
      rows,
    );
  },
});
