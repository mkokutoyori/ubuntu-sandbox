/**
 * V$LOGMNR_DICTIONARY — dictionaries available to LogMiner.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$LOGMNR_DICTIONARY',
  comment: 'Dictionaries loaded for LogMiner',
  query() {
    return queryResult(
      [
        col.str('DB_NAME', 30),
        col.str('DB_ID', 30),
        col.date('FIRST_TIMESTAMP'),
        col.str('STATUS', 13),
      ],
      []
    );
  },
});
