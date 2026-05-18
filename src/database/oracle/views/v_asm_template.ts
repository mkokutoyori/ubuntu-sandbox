/**
 * V$ASM_TEMPLATE — default file-creation templates per diskgroup.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ASM_TEMPLATE',
  comment: 'ASM templates',
  query() {
    return queryResult(
      [
        { name: 'GROUP_NUMBER', dataType: oracleNumber(10) },
        { name: 'ENTRY_NUMBER', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'REDUNDANCY', dataType: oracleVarchar2(6) },
        { name: 'STRIPE', dataType: oracleVarchar2(6) },
        { name: 'SYSTEM', dataType: oracleVarchar2(3) },
        { name: 'PRIMARY_REGION', dataType: oracleVarchar2(4) },
        { name: 'MIRROR_REGION', dataType: oracleVarchar2(4) },
      ],
      []
    );
  },
});
