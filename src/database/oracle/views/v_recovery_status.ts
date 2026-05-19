/**
 * V$RECOVERY_STATUS — media-recovery status. Empty unless a recovery
 * is in progress; the simulator doesn't model recovery sessions.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$RECOVERY_STATUS',
  comment: 'Media recovery status',
  query() {
    return queryResult(
      [
        { name: 'RECOVERY_CHECKPOINT', dataType: oracleDate() },
        { name: 'THREAD', dataType: oracleNumber(10) },
        { name: 'SEQUENCE_NEEDED', dataType: oracleNumber(20) },
        { name: 'SCN_NEEDED', dataType: oracleVarchar2(16) },
        { name: 'TIME_NEEDED', dataType: oracleDate() },
        { name: 'PREVIOUS_LOG_NAME', dataType: oracleVarchar2(513) },
        { name: 'PREVIOUS_LOG_STATUS', dataType: oracleVarchar2(13) },
        { name: 'REASON', dataType: oracleVarchar2(13) },
      ],
      []
    );
  },
});
