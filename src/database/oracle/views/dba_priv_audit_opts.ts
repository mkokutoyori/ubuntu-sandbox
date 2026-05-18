/**
 * DBA_PRIV_AUDIT_OPTS — system-privilege audit options.
 *
 * Real Oracle separates *statement* shorthand auditing (`AUDIT TABLE`,
 * `AUDIT SELECT TABLE`) from *system privilege* auditing (`AUDIT CREATE
 * ANY TABLE`). Both are configured via AUDIT and stored in the catalog's
 * single audit-option store; this view projects exactly the subset whose
 * option is a genuine Oracle system privilege, so it reflects real
 * configuration with no separate hardcoded list.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { isSystemPrivilege } from '../security/systemPrivileges';

registerView({
  name: 'DBA_PRIV_AUDIT_OPTS',
  comment: 'Privilege audit options',
  query({ catalog }) {
    const rows = catalog.getStmtAuditOpts()
      .filter(o => isSystemPrivilege(o.auditOption))
      .map(o => [
        o.userName,        // USER_NAME — null = all users
        null,              // PROXY_NAME — proxy auth not simulated
        o.auditOption,     // PRIVILEGE
        o.success,         // 'BY ACCESS' | 'BY SESSION' | 'NOT SET'
        o.failure,
      ]);
    return queryResult(
      [
        col.str('USER_NAME', 128),
        col.str('PROXY_NAME', 128),
        col.str('PRIVILEGE', 40),
        col.str('SUCCESS', 10),
        col.str('FAILURE', 10),
      ],
      rows
    );
  },
});
