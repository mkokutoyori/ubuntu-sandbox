/**
 * V$ASM_DISK — derived from the live AsmManager. Every disk advertised
 * here exists for real in `instance.asm` and (via the FS sync adapter)
 * on the device VFS at the path reported in the PATH column.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ASM_DISK',
  comment: 'ASM disks',
  query({ instance }) {
    return queryResult(
      [
        { name: 'GROUP_NUMBER', dataType: oracleNumber(10) },
        { name: 'DISK_NUMBER', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'PATH', dataType: oracleVarchar2(256) },
        { name: 'FAILGROUP', dataType: oracleVarchar2(30) },
        { name: 'STATE', dataType: oracleVarchar2(11) },
        { name: 'MODE_STATUS', dataType: oracleVarchar2(7) },
        { name: 'MOUNT_STATUS', dataType: oracleVarchar2(7) },
        { name: 'HEADER_STATUS', dataType: oracleVarchar2(12) },
        { name: 'TOTAL_MB', dataType: oracleNumber(20) },
        { name: 'FREE_MB', dataType: oracleNumber(20) },
        { name: 'CREATE_DATE', dataType: oracleDate() },
      ],
      instance.asm.getAllDisks().map(({ groupNumber, disk }) => [
        groupNumber, disk.diskNumber, disk.name, disk.path, disk.failgroup,
        disk.state, disk.modeStatus, disk.mountStatus, disk.headerStatus,
        disk.sizeMb, disk.freeMb, disk.createDate,
      ])
    );
  },
});
