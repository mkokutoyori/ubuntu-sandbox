/**
 * V$LOGMNR_LOGS — log files currently added to a LogMiner session.
 * Empty until DBMS_LOGMNR.ADD_LOGFILE is called.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$LOGMNR_LOGS',
  comment: 'LogMiner session log files',
  query() {
    return queryResult(
      [
        col.num('LOG_ID'),
        col.str('FILENAME', 513),
        col.num('LOW_SCN'),
        col.num('HIGH_SCN'),
        col.date('LOW_TIME'),
        col.date('HIGH_TIME'),
        col.str('STATUS', 13),
      ],
      []
    );
  },
});
