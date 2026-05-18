/**
 * V$ASM_ALIAS — user-friendly aliases for ASM files (none by default).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ASM_ALIAS',
  comment: 'ASM aliases',
  query() {
    return queryResult(
      [
        { name: 'NAME', dataType: oracleVarchar2(256) },
        { name: 'GROUP_NUMBER', dataType: oracleNumber(10) },
        { name: 'FILE_NUMBER', dataType: oracleNumber(10) },
        { name: 'FILE_INCARNATION', dataType: oracleNumber(20) },
        { name: 'ALIAS_INDEX', dataType: oracleNumber(10) },
        { name: 'ALIAS_INCARNATION', dataType: oracleNumber(20) },
        { name: 'PARENT_INDEX', dataType: oracleNumber(20) },
        { name: 'REFERENCE_INDEX', dataType: oracleNumber(20) },
        { name: 'ALIAS_DIRECTORY', dataType: oracleVarchar2(1) },
        { name: 'SYSTEM_CREATED', dataType: oracleVarchar2(1) },
      ],
      []
    );
  },
});
