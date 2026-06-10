/**
 * V$ASM_CLIENT — DB instances currently attached to the ASM instance.
 * Driven by AsmManager.attachClient — empty until an instance attaches.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ASM_CLIENT',
  comment: 'ASM clients',
  query({ instance }) {
    const rows: (string | number)[][] = [];
    const groupNumber = 1;
    for (const [instanceName, c] of instance.asm.getClients()) {
      rows.push([groupNumber, instanceName, c.dbName, c.status, c.softwareVersion, c.compatibleVersion]);
    }
    return queryResult(
      [
        { name: 'GROUP_NUMBER', dataType: oracleNumber(10) },
        { name: 'INSTANCE_NAME', dataType: oracleVarchar2(64) },
        { name: 'DB_NAME', dataType: oracleVarchar2(8) },
        { name: 'STATUS', dataType: oracleVarchar2(12) },
        { name: 'SOFTWARE_VERSION', dataType: oracleVarchar2(60) },
        { name: 'COMPATIBLE_VERSION', dataType: oracleVarchar2(60) },
      ],
      rows
    );
  },
});
