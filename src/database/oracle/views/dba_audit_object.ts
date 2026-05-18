/**
 * DBA_AUDIT_OBJECT — object-level audit events.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_AUDIT_OBJECT',
  comment: 'Object-level audit trail',
  query() {
    return queryResult(
      [
        col.str('OS_USERNAME', 30),
        col.str('USERNAME', 128),
        col.str('OBJ_NAME', 128),
        col.str('OBJ_OWNER', 128),
        col.date('TIMESTAMP'),
        col.str('ACTION_NAME', 28),
      ],
      []
    );
  },
});
