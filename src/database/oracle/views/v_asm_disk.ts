/**
 * V$ASM_DISK — physical disks backing the simulated ASM diskgroups.
 * Two disks per group (DATA, FRA) to mirror what the matching
 * V$ASM_DISKGROUP advertises.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ASM_DISK',
  comment: 'ASM disks',
  query() {
    return queryResult(
      [
        { name: 'GROUP_NUMBER', dataType: oracleNumber(10) },
        { name: 'DISK_NUMBER', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'PATH', dataType: oracleVarchar2(256) },
        { name: 'STATE', dataType: oracleVarchar2(11) },
        { name: 'MODE_STATUS', dataType: oracleVarchar2(7) },
        { name: 'HEADER_STATUS', dataType: oracleVarchar2(12) },
        { name: 'TOTAL_MB', dataType: oracleNumber(20) },
        { name: 'FREE_MB', dataType: oracleNumber(20) },
      ],
      // No ASM disks in the file-backed simulator — querying real state
      // is correct here: empty.
      []
    );
  },
});
