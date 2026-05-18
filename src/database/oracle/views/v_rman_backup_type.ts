/**
 * V$RMAN_BACKUP_TYPE — backup type catalogue.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$RMAN_BACKUP_TYPE',
  comment: 'Backup type catalogue',
  query() {
    return queryResult(
      [col.num('TYPE_ID'), col.str('WEIGHT', 12), col.str('INPUT_TYPE', 13)],
      [
        [1, 'HEAVY', 'DB FULL'],
        [2, 'MEDIUM', 'DB INCR'],
        [4, 'LIGHT', 'ARCHIVELOG'],
        [8, 'LIGHT', 'CONTROLFILE'],
        [16, 'LIGHT', 'SPFILE'],
      ]
    );
  },
});
