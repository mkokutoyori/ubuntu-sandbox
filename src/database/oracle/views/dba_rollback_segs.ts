/**
 * DBA_ROLLBACK_SEGS — undo / rollback segments.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_ROLLBACK_SEGS',
  comment: 'Rollback segments',
  query({ instance }) {
    const undoTs = instance.getParameter('undo_tablespace') ?? 'UNDOTBS1';
    return queryResult(
      [
        col.str('SEGMENT_NAME', 30),
        col.str('OWNER', 30),
        col.str('TABLESPACE_NAME', 30),
        col.num('SEGMENT_ID'),
        col.str('STATUS', 16),
      ],
      [
        ['SYSTEM', 'SYS', 'SYSTEM', 0, 'ONLINE'],
        ['_SYSSMU1$', 'PUBLIC', undoTs, 1, 'ONLINE'],
        ['_SYSSMU2$', 'PUBLIC', undoTs, 2, 'ONLINE'],
        ['_SYSSMU3$', 'PUBLIC', undoTs, 3, 'ONLINE'],
        ['_SYSSMU4$', 'PUBLIC', undoTs, 4, 'ONLINE'],
      ]
    );
  },
});
