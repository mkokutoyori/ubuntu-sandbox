/**
 * V$RECOVERY_FILE_STATUS — recovery progress per datafile. Empty
 * unless a recovery is active; the simulator does not model that.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$RECOVERY_FILE_STATUS',
  comment: 'Recovery status per datafile',
  query() {
    return queryResult(
      [
        { name: 'FILENUM', dataType: oracleNumber(10) },
        { name: 'FILENAME', dataType: oracleVarchar2(513) },
        { name: 'STATUS', dataType: oracleVarchar2(13) },
      ],
      []
    );
  },
});
