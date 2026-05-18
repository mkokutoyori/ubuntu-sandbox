/**
 * V$LOGMNR_CONTENTS — mined redo records.
 * Empty until DBMS_LOGMNR.START_LOGMNR produces records.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$LOGMNR_CONTENTS',
  comment: 'LogMiner extracted redo content',
  query() {
    return queryResult(
      [
        col.num('SCN'),
        col.num('CSCN'),
        col.date('TIMESTAMP'),
        col.num('THREAD#'),
        col.str('OPERATION', 32),
        col.str('SEG_OWNER', 30),
        col.str('SEG_NAME', 30),
        col.str('TABLE_NAME', 30),
        col.str('USERNAME', 30),
        col.str('SQL_REDO', 4000),
        col.str('SQL_UNDO', 4000),
      ],
      []
    );
  },
});
