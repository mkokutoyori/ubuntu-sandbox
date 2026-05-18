/**
 * V$ARCHIVE_GAP — missing archive log ranges. Empty when no Data Guard
 * standby exists (our default).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$ARCHIVE_GAP',
  comment: 'Archive log gaps',
  query() {
    return queryResult(
      [col.num('THREAD#'), col.num('LOW_SEQUENCE#'), col.num('HIGH_SEQUENCE#')],
      []
    );
  },
});
