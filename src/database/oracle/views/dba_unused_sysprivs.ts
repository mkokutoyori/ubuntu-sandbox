/**
 * DBA_UNUSED_SYSPRIVS — system privileges granted but never used.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { ORACLE_SYSTEM_PRIVILEGES } from '../security/systemPrivileges';

registerView({
  name: 'DBA_UNUSED_SYSPRIVS',
  comment: 'Granted but unused system privileges',
  query({ catalog, instance }) {
    const used = new Set(
      instance.getAuditJournal().getPrivilegeUsage()
        .filter(r => ORACLE_SYSTEM_PRIVILEGES.has(r.privilege))
        .map(r => `${r.username}|${r.privilege}`),
    );
    const rows: string[][] = [];
    const seen = new Set<string>();
    for (const sp of catalog.getSysPrivilegeGrants()) {
      if (!ORACLE_SYSTEM_PRIVILEGES.has(sp.privilege)) continue;
      const k = `${sp.grantee}|${sp.privilege}`;
      if (used.has(k) || seen.has(k)) continue;
      seen.add(k);
      rows.push(['ORA_$DEPENDENCY', sp.grantee, sp.privilege, sp.privilege]);
    }
    return queryResult(
      [
        col.str('CAPTURE', 128),
        col.str('USERNAME', 128),
        col.str('SYS_PRIV', 128),
        col.str('PATH', 4000),
      ],
      rows,
    );
  },
});
