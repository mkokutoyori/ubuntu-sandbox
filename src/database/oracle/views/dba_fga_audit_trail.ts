/**
 * DBA_FGA_AUDIT_TRAIL — fine-grained audit entries.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_FGA_AUDIT_TRAIL',
  comment: 'Fine-grained audit trail',
  query() {
    return queryResult(
      [
        col.str('SESSION_ID', 30),
        col.date('TIMESTAMP'),
        col.str('DB_USER', 128),
        col.str('OS_USER', 30),
        col.str('OBJECT_SCHEMA', 30),
        col.str('OBJECT_NAME', 30),
        col.str('POLICY_NAME', 30),
        col.str('SQL_TEXT', 2000),
      ],
      []
    );
  },
});
