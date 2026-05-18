/**
 * DBA_SEQUENCES — sequences. Storage exposes sequences indirectly; the
 * column shape matches Oracle 19c and is filled as storage support
 * lands (kept faithful to the prior catalog behaviour).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_SEQUENCES',
  comment: 'Sequences',
  query() {
    return queryResult(
      [
        { name: 'SEQUENCE_OWNER', dataType: oracleVarchar2(30) },
        { name: 'SEQUENCE_NAME', dataType: oracleVarchar2(30) },
        { name: 'MIN_VALUE', dataType: oracleNumber(28) },
        { name: 'MAX_VALUE', dataType: oracleNumber(28) },
        { name: 'INCREMENT_BY', dataType: oracleNumber(28) },
        { name: 'LAST_NUMBER', dataType: oracleNumber(28) },
      ],
      []
    );
  },
});
