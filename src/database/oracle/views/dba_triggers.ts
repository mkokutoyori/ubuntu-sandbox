/**
 * DBA_TRIGGERS — database triggers. No trigger store yet; Oracle 19c
 * column shape preserved so auditor scripts run unmodified.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_TRIGGERS',
  comment: 'Database triggers',
  query() {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'TRIGGER_NAME', dataType: oracleVarchar2(30) },
        { name: 'TRIGGER_TYPE', dataType: oracleVarchar2(16) },
        { name: 'TRIGGERING_EVENT', dataType: oracleVarchar2(227) },
        { name: 'TABLE_OWNER', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'STATUS', dataType: oracleVarchar2(8) },
      ],
      []
    );
  },
});
