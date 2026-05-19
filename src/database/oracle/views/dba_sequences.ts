/**
 * DBA_SEQUENCES — every sequence in the database, derived from
 * `storage.getAllSequences()`. Mirrors the Oracle 19c column set.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_SEQUENCES',
  comment: 'Sequences',
  query({ storage }) {
    return queryResult(
      [
        { name: 'SEQUENCE_OWNER', dataType: oracleVarchar2(30) },
        { name: 'SEQUENCE_NAME', dataType: oracleVarchar2(30) },
        { name: 'MIN_VALUE', dataType: oracleNumber(28) },
        { name: 'MAX_VALUE', dataType: oracleNumber(28) },
        { name: 'INCREMENT_BY', dataType: oracleNumber(28) },
        { name: 'CYCLE_FLAG', dataType: oracleVarchar2(1) },
        { name: 'ORDER_FLAG', dataType: oracleVarchar2(1) },
        { name: 'CACHE_SIZE', dataType: oracleNumber(28) },
        { name: 'LAST_NUMBER', dataType: oracleNumber(28) },
      ],
      storage.getAllSequences().map(({ schema, sequence: s }) => [
        schema,
        s.name,
        s.minValue,
        s.maxValue,
        s.incrementBy,
        s.cycle ? 'Y' : 'N',
        'N',
        s.cache,
        s.currentValue,
      ]),
    );
  },
});
