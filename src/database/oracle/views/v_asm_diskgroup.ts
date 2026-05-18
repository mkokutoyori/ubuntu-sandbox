/**
 * V$ASM_DISKGROUP — ASM disk groups (simulated DATA/FRA groups).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ASM_DISKGROUP',
  comment: 'ASM disk groups',
  query() {
    return queryResult(
      [
        { name: 'GROUP_NUMBER', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'SECTOR_SIZE', dataType: oracleNumber(10) },
        { name: 'BLOCK_SIZE', dataType: oracleNumber(10) },
        { name: 'ALLOCATION_UNIT_SIZE', dataType: oracleNumber(20) },
        { name: 'STATE', dataType: oracleVarchar2(11) },
        { name: 'TYPE', dataType: oracleVarchar2(6) },
        { name: 'TOTAL_MB', dataType: oracleNumber(20) },
        { name: 'FREE_MB', dataType: oracleNumber(20) },
      ],
      [
        [1, 'DATA', 512, 4096, 1048576, 'MOUNTED', 'EXTERN', 102400, 81920],
        [2, 'FRA', 512, 4096, 1048576, 'MOUNTED', 'EXTERN', 51200, 40960],
      ]
    );
  },
});
