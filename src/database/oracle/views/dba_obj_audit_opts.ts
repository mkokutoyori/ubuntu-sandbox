/**
 * DBA_OBJ_AUDIT_OPTS — object-level audit options.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_OBJ_AUDIT_OPTS',
  comment: 'Object audit options',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('OBJECT_NAME', 30),
        col.str('OBJECT_TYPE', 16),
        col.str('ALT', 3),
        col.str('AUD', 3),
        col.str('COM', 3),
        col.str('DEL', 3),
        col.str('GRA', 3),
        col.str('IND', 3),
        col.str('INS', 3),
        col.str('LOC', 3),
        col.str('REN', 3),
        col.str('SEL', 3),
        col.str('UPD', 3),
      ],
      []
    );
  },
});
