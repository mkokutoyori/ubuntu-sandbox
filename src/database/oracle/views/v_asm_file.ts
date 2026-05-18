/**
 * V$ASM_FILE — ASM files (one stub row per simulated diskgroup).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ASM_FILE',
  comment: 'ASM files',
  query() {
    return queryResult(
      [
        { name: 'GROUP_NUMBER', dataType: oracleNumber(10) },
        { name: 'FILE_NUMBER', dataType: oracleNumber(10) },
        { name: 'INCARNATION', dataType: oracleNumber(20) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'TYPE', dataType: oracleVarchar2(64) },
        { name: 'REDUNDANCY', dataType: oracleVarchar2(6) },
        { name: 'STRIPED', dataType: oracleVarchar2(6) },
        { name: 'CREATION_DATE', dataType: oracleVarchar2(30) },
      ],
      []
    );
  },
});
