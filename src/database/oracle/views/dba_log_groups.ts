/**
 * DBA_LOG_GROUPS — supplemental log groups. Empty until the catalog
 * tracks ALTER TABLE … ADD SUPPLEMENTAL LOG GROUP definitions
 * (currently a metadata-only no-op in the simulator).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_LOG_GROUPS',
  comment: 'Supplemental log groups',
  query() {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'LOG_GROUP_NAME', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'LOG_GROUP_TYPE', dataType: oracleVarchar2(19) },
        { name: 'ALWAYS', dataType: oracleVarchar2(11) },
        { name: 'GENERATED', dataType: oracleVarchar2(14) },
      ],
      []
    );
  },
});
