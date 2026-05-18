/**
 * V$ASM_FILE — derived from AsmManager (currently no file-creation
 * API on the simulator, so this is empty until DBMS_FILE_TRANSFER or
 * a CREATE … TABLESPACE pointed at +DG is implemented).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ASM_FILE',
  comment: 'ASM files',
  query({ instance }) {
    return queryResult(
      [
        { name: 'GROUP_NUMBER', dataType: oracleNumber(10) },
        { name: 'FILE_NUMBER', dataType: oracleNumber(10) },
        { name: 'INCARNATION', dataType: oracleNumber(20) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'TYPE', dataType: oracleVarchar2(64) },
        { name: 'REDUNDANCY', dataType: oracleVarchar2(6) },
        { name: 'STRIPED', dataType: oracleVarchar2(6) },
        { name: 'CREATION_DATE', dataType: oracleDate() },
      ],
      instance.asm.getAllFiles().map(({ groupNumber, file }) => [
        groupNumber, file.fileNumber, file.incarnation, file.bytes,
        file.type, file.redundancy, file.striped, file.createDate,
      ])
    );
  },
});
