/**
 * V$ASM_DISKGROUP — derived from the live AsmManager on the instance.
 * Empty until the DBA issues CREATE DISKGROUP.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ASM_DISKGROUP',
  comment: 'ASM disk groups',
  query({ instance }) {
    const asm = instance.asm;
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
      asm.getAllDiskgroups().map(dg => [
        dg.groupNumber, dg.name, dg.sectorSize, dg.blockSize, dg.allocationUnitSize,
        dg.state, redundancyShort(dg.redundancy),
        asm.totalMb(dg), asm.freeMb(dg),
      ])
    );
  },
});

function redundancyShort(r: 'EXTERNAL' | 'NORMAL' | 'HIGH'): 'EXTERN' | 'NORMAL' | 'HIGH' {
  return r === 'EXTERNAL' ? 'EXTERN' : r;
}
