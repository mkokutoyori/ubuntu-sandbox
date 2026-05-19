/**
 * V$ASM_ATTRIBUTE — per-diskgroup ASM attributes. The simulator only
 * implements the few attributes implied by the diskgroup metadata
 * (compatibility versions, allocation_unit_size, sector_size, …).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ASM_ATTRIBUTE',
  comment: 'ASM diskgroup attributes',
  query({ instance }) {
    const rows: (string | number)[][] = [];
    for (const dg of instance.asm.getAllDiskgroups()) {
      const push = (name: string, value: string, system: 'Y' | 'N' = 'Y') =>
        rows.push([name, value, dg.groupNumber, 0, system, 'N']);
      push('disk_repair_time', '3.6h');
      push('au_size', String(dg.allocationUnitSize));
      push('sector_size', String(dg.sectorSize));
      push('compatible.asm', '19.0.0.0.0');
      push('compatible.rdbms', '19.0.0.0.0');
    }
    return queryResult(
      [
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'VALUE', dataType: oracleVarchar2(64) },
        { name: 'GROUP_NUMBER', dataType: oracleNumber(10) },
        { name: 'ATTRIBUTE_INDEX', dataType: oracleNumber(10) },
        { name: 'SYSTEM_CREATED', dataType: oracleVarchar2(1) },
        { name: 'READ_ONLY', dataType: oracleVarchar2(1) },
      ],
      rows
    );
  },
});
