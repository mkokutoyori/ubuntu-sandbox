/**
 * V$ASM_TEMPLATE — one row per diskgroup × default file template.
 * The template list is what Oracle creates automatically on every
 * diskgroup; users normally add their own with ALTER DISKGROUP ADD
 * TEMPLATE (not yet supported in the simulator).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';
import { DEFAULT_ASM_TEMPLATES } from '../asm/AsmManager';

registerView({
  name: 'V$ASM_TEMPLATE',
  comment: 'ASM templates',
  query({ instance }) {
    const rows: (string | number)[][] = [];
    for (const dg of instance.asm.getAllDiskgroups()) {
      DEFAULT_ASM_TEMPLATES.forEach((tpl, i) => {
        rows.push([
          dg.groupNumber, i, tpl.name,
          dg.redundancy === 'EXTERNAL' ? 'UNPROT' : (dg.redundancy === 'HIGH' ? 'HIGH' : 'MIRROR'),
          tpl.stripe, 'Y',
        ]);
      });
    }
    return queryResult(
      [
        { name: 'GROUP_NUMBER', dataType: oracleNumber(10) },
        { name: 'ENTRY_NUMBER', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'REDUNDANCY', dataType: oracleVarchar2(6) },
        { name: 'STRIPE', dataType: oracleVarchar2(6) },
        { name: 'SYSTEM', dataType: oracleVarchar2(3) },
      ],
      rows
    );
  },
});
