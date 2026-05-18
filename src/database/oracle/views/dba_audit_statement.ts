/**
 * DBA_AUDIT_STATEMENT — statement-level audit events.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_AUDIT_STATEMENT',
  comment: 'Statement-level audit trail',
  query() {
    return queryResult(
      [
        col.str('OS_USERNAME', 30),
        col.str('USERNAME', 128),
        col.str('USERHOST', 128),
        col.date('TIMESTAMP'),
        col.str('ACTION_NAME', 28),
        col.str('OBJ_NAME', 128),
        col.str('SQL_TEXT', 2000),
        col.num('RETURNCODE'),
      ],
      []
    );
  },
});
