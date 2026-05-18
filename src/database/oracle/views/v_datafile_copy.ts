/**
 * V$DATAFILE_COPY — RMAN image copies of datafiles.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$DATAFILE_COPY',
  comment: 'RMAN image copies of datafiles',
  query() {
    return queryResult(
      [
        col.num('RECID'),
        col.num('FILE#'),
        col.str('NAME', 513),
        col.str('STATUS', 1),
        col.date('COMPLETION_TIME'),
        col.num('BYTES'),
      ],
      []
    );
  },
});
