/**
 * V$DATABASE — database identity, log/open mode, supplemental-log
 * flags, control-file type, all derived from the live instance.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$DATABASE',
  comment: 'Database information',
  query({ instance }) {
    const supp = instance.supplementalLog;
    return queryResult(
      [
        { name: 'DBID', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(9) },
        { name: 'CREATED', dataType: oracleDate() },
        { name: 'LOG_MODE', dataType: oracleVarchar2(12) },
        { name: 'OPEN_MODE', dataType: oracleVarchar2(20) },
        { name: 'DATABASE_ROLE', dataType: oracleVarchar2(16) },
        { name: 'PLATFORM_NAME', dataType: oracleVarchar2(101) },
        { name: 'CONTROLFILE_TYPE', dataType: oracleVarchar2(7) },
        { name: 'CONTROLFILE_CREATED', dataType: oracleDate() },
        { name: 'CONTROLFILE_SEQUENCE#', dataType: oracleNumber(20) },
        { name: 'CONTROLFILE_CHANGE#', dataType: oracleNumber(20) },
        { name: 'CONTROLFILE_TIME', dataType: oracleDate() },
        { name: 'SUPPLEMENTAL_LOG_DATA_MIN', dataType: oracleVarchar2(8) },
        { name: 'SUPPLEMENTAL_LOG_DATA_PK', dataType: oracleVarchar2(3) },
        { name: 'SUPPLEMENTAL_LOG_DATA_UI', dataType: oracleVarchar2(3) },
        { name: 'SUPPLEMENTAL_LOG_DATA_FK', dataType: oracleVarchar2(3) },
        { name: 'SUPPLEMENTAL_LOG_DATA_ALL', dataType: oracleVarchar2(3) },
        { name: 'FORCE_LOGGING', dataType: oracleVarchar2(3) },
        { name: 'FLASHBACK_ON', dataType: oracleVarchar2(18) },
        { name: 'CURRENT_SCN', dataType: oracleNumber(20) },
        { name: 'CHECKPOINT_CHANGE#', dataType: oracleNumber(20) },
      ],
      [[
        instance.getDbId(), instance.config.sid, new Date().toISOString(),
        instance.archiveLogMode ? 'ARCHIVELOG' : 'NOARCHIVELOG',
        instance.state === 'OPEN' ? 'READ WRITE' : 'MOUNTED',
        'PRIMARY', 'Linux x86 64-bit', 'CURRENT',
        new Date('2026-01-01T00:00:00Z'),
        1, instance.getCheckpointScn(), instance.getCheckpointTime(),
        supp.min, supp.pk ? 'YES' : 'NO', supp.ui ? 'YES' : 'NO',
        supp.fk ? 'YES' : 'NO', supp.all ? 'YES' : 'NO',
        instance.forceLogging ? 'YES' : 'NO',
        instance.flashbackOn ? 'YES' : 'NO',
        instance.getCurrentScn(), instance.getCheckpointScn(),
      ]]
    );
  },
});
