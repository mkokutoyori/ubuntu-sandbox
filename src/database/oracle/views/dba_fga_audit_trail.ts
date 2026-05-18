/**
 * DBA_FGA_AUDIT_TRAIL — fine-grained audit entries.
 *
 * One row per matching DML/SELECT against a table protected by an FGA
 * policy. Records are produced by the executor calling
 * `OracleCatalog.recordFgaAudit` when its DML pre-flight finds a
 * matching policy (see `matchFgaPolicies`).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_FGA_AUDIT_TRAIL',
  comment: 'Fine-grained audit trail',
  query({ catalog }) {
    return queryResult(
      [
        col.num('SESSION_ID'),
        col.date('TIMESTAMP'),
        col.str('DB_USER', 128),
        col.str('OS_USER', 30),
        col.str('OBJECT_SCHEMA', 30),
        col.str('OBJECT_NAME', 30),
        col.str('POLICY_NAME', 30),
        col.str('SQL_TEXT', 2000),
        col.str('STATEMENT_TYPE', 28),
      ],
      catalog.getFgaTrail().map(f => [
        f.sessionId, f.timestamp.toISOString(), f.dbUser, f.osUser,
        f.objectSchema, f.objectName, f.policyName, f.sqlText, f.statementType,
      ])
    );
  },
});
