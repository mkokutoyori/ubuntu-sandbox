/**
 * DBA_DDL_LOG — DDL log table (native to Oracle 12c+).
 *
 * Populated by `ENABLE_DDL_LOGGING` — each DDL statement appears with
 * its SCN, executor, operation type, target object and SQL text. We
 * surface the same data the SecurityAuditActor already journals, so
 * the two views (UNIFIED_AUDIT_TRAIL filtered on STATEMENT_TYPE='DDL'
 * and DBA_DDL_LOG) stay coherent.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_DDL_LOG',
  comment: 'DDL log (ENABLE_DDL_LOGGING)',
  query({ instance }) {
    return queryResult(
      [
        col.num('USER_NAME', 128),
        col.str('OWNER', 128),
        col.str('OPERATION', 30),
        col.str('TYPE', 30),
        col.str('OBJECT_NAME', 128),
        col.str('SQL_TEXT', 4000),
        col.date('TIMESTAMP'),
        col.num('XID'),
      ],
      instance.getAuditJournal().getDdlHistory().map(r => [
        r.username, r.schema, r.kind, r.objectType ?? 'TABLE',
        r.objectName, r.sqlText, r.timestamp.toISOString(), r.scn,
      ]),
    );
  },
});
