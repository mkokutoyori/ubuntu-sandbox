/**
 * DBA_DV_REALM — Database Vault realms. Rows come from
 * `OracleCatalog.getDvRealms()` (admin-created via DBMS_MACADM).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_DV_REALM',
  comment: 'Database Vault realms',
  query({ catalog }) {
    const c = catalog as unknown as { getDvRealms?: () => { name: string; description: string; auditOptions: number; enabled: boolean }[] };
    const rows = c.getDvRealms ? c.getDvRealms() : [];
    return queryResult(
      [
        col.str('NAME', 90),
        col.str('DESCRIPTION', 1024),
        col.num('AUDIT_OPTIONS'),
        col.str('ENABLED', 1),
      ],
      rows.map(r => [r.name, r.description, r.auditOptions, r.enabled ? 'Y' : 'N'])
    );
  },
});
