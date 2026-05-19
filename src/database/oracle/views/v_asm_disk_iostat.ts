/**
 * V$ASM_DISK_IOSTAT — per-ASM-disk I/O counters. Derived from the
 * AsmManager (rows for real disks, all counters zero until per-disk
 * I/O accounting is added).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$ASM_DISK_IOSTAT',
  comment: 'Per-ASM-disk I/O statistics',
  query({ instance }) {
    return queryResult(
      [
        { name: 'GROUP_NUMBER', dataType: oracleNumber(10) },
        { name: 'DISK_NUMBER', dataType: oracleNumber(10) },
        { name: 'INSTNAME', dataType: oracleVarchar2(64) },
        { name: 'DBNAME', dataType: oracleVarchar2(8) },
        { name: 'READS', dataType: oracleNumber(20) },
        { name: 'WRITES', dataType: oracleNumber(20) },
        { name: 'READ_ERRS', dataType: oracleNumber(20) },
        { name: 'WRITE_ERRS', dataType: oracleNumber(20) },
        { name: 'READ_TIME', dataType: oracleNumber(20) },
        { name: 'WRITE_TIME', dataType: oracleNumber(20) },
        { name: 'BYTES_READ', dataType: oracleNumber(20) },
        { name: 'BYTES_WRITTEN', dataType: oracleNumber(20) },
      ],
      instance.asm.getAllDisks().map(({ groupNumber, disk }) => [
        groupNumber, disk.diskNumber, '', '',
        0, 0, 0, 0, 0, 0, 0, 0,
      ])
    );
  },
});
