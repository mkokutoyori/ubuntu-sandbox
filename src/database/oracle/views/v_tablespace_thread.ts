/**
 * V$TABLESPACE_THREAD — undo tablespace assignment per RAC thread.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$TABLESPACE_THREAD',
  comment: 'Undo tablespace per RAC thread',
  query({ instance }) {
    return queryResult(
      [col.num('THREAD#'), col.str('TABLESPACE_NAME', 30)],
      [[1, instance.getParameter('undo_tablespace') ?? 'UNDOTBS1']]
    );
  },
});
